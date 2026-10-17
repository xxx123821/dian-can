/** Protected merchant API. */
import { seaTableRequest } from './_seatable.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const numberOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const rowsFrom = (data) => Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
const field = (row, ...names) => {
  for (const name of names) if (row?.[name] !== undefined && row?.[name] !== null) return row[name];
  return '';
};
const enabled = (value) => !['0', 'false', 'no', 'off', '否', '停用', '下架'].includes(String(value ?? '').trim().toLowerCase());

function parseMap(raw, label) {
  if (!String(raw || '').trim()) return {};
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch (_) { throw new Error(`${label} 必须是有效 JSON 对象`); }
}
const MENU_DEFAULT_COLUMNS = { type: '类型', key: '键', name: '名称', price: '价格', mainCount: '主荤数量', sideCount: '副荤数量', group: '分组', sort: '排序', mealPeriod: '餐段', value: '值', enabled: '启用', published: '上架' };
const ORDER_DEFAULT_COLUMNS = { orderNo: '订单号', orderDate: '订单日期', sequenceNo: '序号', mealPeriod: '用餐时段', packageName: '套餐名称', price: '价格', mainMeat: '主荤', sideMeat: '副荤', name: '姓名', phone: '电话' };
const STATS_DEFAULT_COLUMNS = { orderDate: '订单日期', dishGroup: '分组', dishName: '菜名', quantity: '份数' };
function columnName(map, key) { return clean(map[key] || MENU_DEFAULT_COLUMNS[key] || key, 100) || key; }
function resolveMenuMap(rows, configured) {
  const map = { ...configured };
  const sample = rows.find((row) => row && typeof row === 'object') || {};
  const aliases = { type: ['类型', 'type'], key: ['键', 'key'], name: ['名称', 'name'], price: ['价格', 'price'], mainCount: ['主荤数量', 'mainCount'], sideCount: ['副荤数量', 'sideCount'], group: ['分组', 'group'], sort: ['排序', 'sort'], mealPeriod: ['餐段', 'mealPeriod'], value: ['值', 'value'], enabled: ['启用', 'enabled'], published: ['上架', 'published'] };
  for (const key of Object.keys(MENU_DEFAULT_COLUMNS)) if (!map[key]) map[key] = aliases[key].find((name) => Object.prototype.hasOwnProperty.call(sample, name)) || MENU_DEFAULT_COLUMNS[key];
  return map;
}
async function seaTable(env, tableName, method = 'GET', row = null, rowId = '') {
  return seaTableRequest(env, tableName, method, row, rowId);
}
function assertAdmin(request, env) {
  const configuredPassword = clean(env.ADMIN_PASSWORD, 300);
  if (configuredPassword) {
    const providedPassword = clean(request.headers.get('X-Admin-Password'), 300);
    if (!providedPassword) throw Object.assign(new Error('请输入商家后台密码'), { status: 401 });
    if (providedPassword !== configuredPassword) throw Object.assign(new Error('商家后台密码不正确'), { status: 403 });
    return;
  }
  const allowed = clean(env.ADMIN_ACCESS_EMAILS, 1000).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const email = clean(request.headers.get('Cf-Access-Authenticated-User-Email'), 200).toLowerCase();
  if (!allowed.length) throw Object.assign(new Error('后台尚未启用访问保护：请设置 ADMIN_ACCESS_EMAILS，并用 Cloudflare Access 保护 /admin.html 与 /api/admin'), { status: 503 });
  if (!email || !allowed.includes(email)) throw Object.assign(new Error('没有商家后台访问权限'), { status: 403 });
}
function beijingDate() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function dateOnly(value) { return String(value || '').slice(0, 10); }
function isDateKey(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function dateDistance(from, to) {
  if (!isDateKey(from) || !isDateKey(to)) return NaN;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
function allowedHistoryDate(value) {
  const today = beijingDate();
  const target = isDateKey(value) ? value : today;
  const age = dateDistance(target, today);
  if (!Number.isFinite(age) || age < 0 || age > 6) throw Object.assign(new Error('历史记录只保留最近 7 天'), { status: 400 });
  return target;
}
function normalizeSetting(row, map) { return { id: clean(row?._id, 100), key: clean(field(row, columnName(map, 'key'), 'key', '键'), 80), value: clean(field(row, columnName(map, 'value'), 'value', '值'), 500), enabled: enabled(field(row, columnName(map, 'enabled'), 'enabled', '启用')), published: enabled(field(row, columnName(map, 'published'), 'published', '上架')) }; }

async function readMenuRows(env) { return rowsFrom(await seaTable(env, env.SEATABLE_MENU_TABLE_NAME, 'GET')); }
async function readLive(env, requestedDate = '') {
  const orderMap = { ...ORDER_DEFAULT_COLUMNS, ...parseMap(env.SEATABLE_COLUMN_MAP, 'SEATABLE_COLUMN_MAP') };
  const statsMap = { ...STATS_DEFAULT_COLUMNS, ...parseMap(env.SEATABLE_STATS_COLUMN_MAP, 'SEATABLE_STATS_COLUMN_MAP') };
  const targetDate = allowedHistoryDate(requestedDate);
  const orders = rowsFrom(await seaTable(env, env.SEATABLE_TABLE_NAME, 'GET')).filter((row) => dateOnly(field(row, columnName(orderMap, 'orderDate'), 'orderDate', '日期')) === targetDate).map((row) => ({
    orderNo: field(row, columnName(orderMap, 'orderNo'), 'orderNo', '订单号'), sequenceNo: field(row, columnName(orderMap, 'sequenceNo'), 'sequenceNo', '序号', '订单序号'),
    mealPeriod: field(row, columnName(orderMap, 'mealPeriod'), 'mealPeriod', '用餐时段'), packageName: field(row, columnName(orderMap, 'packageName'), 'packageName', '套餐名称'),
    price: field(row, columnName(orderMap, 'price'), 'price', '价格'), mainMeat: field(row, columnName(orderMap, 'mainMeat'), 'mainMeat', '主荤', '主肉'), sideMeat: field(row, columnName(orderMap, 'sideMeat'), 'sideMeat', '副荤', '半荤'),
    name: field(row, columnName(orderMap, 'name'), 'name', '姓名'), phone: field(row, columnName(orderMap, 'phone'), 'phone', '手机号码', '电话')
  }));
  const statsRows = rowsFrom(await seaTable(env, env.SEATABLE_STATS_TABLE_NAME, 'GET')).filter((row) => dateOnly(field(row, columnName(statsMap, 'orderDate'), 'orderDate', '日期')) === targetDate);
  const totals = {};
  statsRows.forEach((row) => { const name = clean(field(row, columnName(statsMap, 'dishName'), 'dishName', '菜名', '菜品名称'), 80); if (!name) return; const group = clean(field(row, columnName(statsMap, 'dishGroup'), 'dishGroup', '分组'), 30); totals[`${group}::${name}`] = (totals[`${group}::${name}`] || 0) + numberOr(field(row, columnName(statsMap, 'quantity'), 'quantity', '份数'), 1); });
  const stats = Object.entries(totals).map(([key, quantity]) => { const [group, dishName] = key.split('::'); return { group, dishName, quantity }; }).sort((a, b) => a.group.localeCompare(b.group) || a.dishName.localeCompare(b.dishName));
  return { date: targetDate, orders, stats, historyRetentionDays: 7 };
}

function normalizeMenu(rows, map) {
  map = resolveMenuMap(rows, map);
  const packages = []; const dishes = []; const settings = {};
  rows.forEach((row, index) => {
    const type = clean(field(row, columnName(map, 'type'), 'type', '类型', 'itemType'), 30).toLowerCase();
    const common = { id: clean(row?._id, 100), enabled: enabled(field(row, columnName(map, 'enabled'), 'enabled', '启用')), published: enabled(field(row, columnName(map, 'published'), 'published', '上架')) };
    if (type === 'setting' || type === '设置') {
      const item = normalizeSetting(row, map);
      // Failed earlier saves may leave duplicate setting rows. Prefer a
      // non-empty value so an empty duplicate cannot hide a valid setting.
      if (item.key && (!settings[item.key] || item.value || !settings[item.key].value)) settings[item.key] = item;
      return;
    }
    const mealPeriod = clean(field(row, columnName(map, 'mealPeriod'), 'mealPeriod', '餐段'), 20) || '全部';
    if (type === 'package' || type === '套餐') { packages.push({ ...common, type: 'package', mealPeriod, key: clean(field(row, columnName(map, 'key'), 'key', '套餐键'), 20), name: clean(field(row, columnName(map, 'name'), 'name', '套餐名称'), 60), price: numberOr(field(row, columnName(map, 'price'), 'price', '价格')), mainCount: Math.max(0, Math.floor(numberOr(field(row, columnName(map, 'mainCount'), 'mainCount', '主荤数量', '主肉数量')))), sideCount: Math.max(0, Math.floor(numberOr(field(row, columnName(map, 'sideCount'), 'sideCount', '副荤数量', '半荤数量')))) }); return; }
    if (type === 'dish' || type === '菜品') { dishes.push({ ...common, type: 'dish', mealPeriod, key: clean(field(row, columnName(map, 'key'), 'key', '菜品键'), 60) || `dish-${index + 1}`, name: clean(field(row, columnName(map, 'name'), 'name', '菜名', '菜品名称'), 80), group: clean(field(row, columnName(map, 'group'), 'group', '分组'), 30), sort: numberOr(field(row, columnName(map, 'sort'), 'sort', '排序'), index) }); }
  });
  packages.sort((a, b) => a.key.localeCompare(b.key)); dishes.sort((a, b) => a.sort - b.sort); return { packages, dishes, settings };
}
function rowForItem(item, map) {
  const typeLabel = item.type === 'package' ? '套餐' : '菜品';
  const row = { [columnName(map, 'type')]: typeLabel, [columnName(map, 'key')]: clean(item.key, 80), [columnName(map, 'name')]: clean(item.name, 100), [columnName(map, 'mealPeriod')]: clean(item.mealPeriod, 20) || '全部', [columnName(map, 'enabled')]: Boolean(item.enabled), [columnName(map, 'published')]: Boolean(item.published) };
  if (item.type === 'package') Object.assign(row, { [columnName(map, 'price')]: numberOr(item.price), [columnName(map, 'mainCount')]: Math.max(0, Math.floor(numberOr(item.mainCount))), [columnName(map, 'sideCount')]: Math.max(0, Math.floor(numberOr(item.sideCount))) });
  if (item.type === 'dish') Object.assign(row, { [columnName(map, 'group')]: clean(item.group, 30), [columnName(map, 'sort')]: numberOr(item.sort) });
  return row;
}
async function saveMenu(env, payload) {
  const table = clean(env.SEATABLE_MENU_TABLE_NAME, 100); if (!table) throw new Error('未配置菜单表');
  const configuredMap = parseMap(env.SEATABLE_MENU_COLUMN_MAP, 'SEATABLE_MENU_COLUMN_MAP'); const existing = await readMenuRows(env); const map = resolveMenuMap(existing, configuredMap); const byId = new Map(existing.map((row) => [clean(row._id, 100), row]));
  const items = [...(Array.isArray(payload.packages) ? payload.packages : []), ...(Array.isArray(payload.dishes) ? payload.dishes : [])];
  for (const item of items) { if (!clean(item.name, 100) || !clean(item.key, 80)) continue; const row = rowForItem(item, map); const id = clean(item.id, 100); if (id && byId.has(id)) await seaTable(env, table, 'PUT', row, id); else await seaTable(env, table, 'POST', row); }
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
  const settingRows = new Map(existing.filter((row) => ['setting', '设置'].includes(clean(field(row, columnName(map, 'type'), 'type', '类型'), 30).toLowerCase())).map((row) => [clean(field(row, columnName(map, 'key'), 'key', '键'), 80), row]));
  for (const key of ['contactName', 'contactPhone', 'lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd']) {
    const row = { [columnName(map, 'type')]: '设置', [columnName(map, 'key')]: key, [columnName(map, 'value')]: clean(settings[key], 500), [columnName(map, 'enabled')]: true, [columnName(map, 'published')]: true };
    const old = settingRows.get(key);
    if (old?._id) await seaTable(env, table, 'PUT', row, old._id); else await seaTable(env, table, 'POST', row);
  }
  return normalizeMenu(await readMenuRows(env), map);
}

async function saveSettings(env, settings) {
  const table = clean(env.SEATABLE_MENU_TABLE_NAME, 100); if (!table) throw new Error('未配置菜单表');
  const configuredMap = parseMap(env.SEATABLE_MENU_COLUMN_MAP, 'SEATABLE_MENU_COLUMN_MAP');
  const existing = await readMenuRows(env); const map = resolveMenuMap(existing, configuredMap);
  const settingRows = new Map(existing.filter((row) => ['setting', '设置'].includes(clean(field(row, columnName(map, 'type'), 'type', '类型'), 30).toLowerCase())).map((row) => [clean(field(row, columnName(map, 'key'), 'key', '键'), 80), row]));
  for (const key of ['contactName', 'contactPhone', 'lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd']) {
    const row = { [columnName(map, 'type')]: '设置', [columnName(map, 'key')]: key, [columnName(map, 'value')]: clean(settings?.[key], 500), [columnName(map, 'enabled')]: true, [columnName(map, 'published')]: true };
    const old = settingRows.get(key);
    if (old?._id) await seaTable(env, table, 'PUT', row, old._id); else await seaTable(env, table, 'POST', row);
  }
  return normalizeMenu(await readMenuRows(env), map);
}

export async function onRequest(context) {
  try {
    assertAdmin(context.request, context.env);
    if (context.request.method === 'GET') {
      const url = new URL(context.request.url);
      if (url.searchParams.get('section') === 'live' || url.searchParams.get('section') === 'history') return json({ ok: true, ...(await readLive(context.env, url.searchParams.get('date') || '')) });
      const map = parseMap(context.env.SEATABLE_MENU_COLUMN_MAP, 'SEATABLE_MENU_COLUMN_MAP');
      return json({ ok: true, menu: normalizeMenu(await readMenuRows(context.env), map), ...(await readLive(context.env)) });
    }
    if (context.request.method === 'POST') {
      const payload = await context.request.json();
      if (payload?.quickOnly) return json({ ok: true, menu: await saveSettings(context.env, payload.settings || {}) });
      return json({ ok: true, menu: await saveMenu(context.env, payload) });
    }
    return json({ ok: false, error: 'Method Not Allowed' }, 405);
  } catch (error) { console.error('Admin request failed', error); return json({ ok: false, error: error.message || '后台请求失败' }, error.status || 502); }
}
