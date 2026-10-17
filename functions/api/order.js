/** Cloudflare Pages order endpoint. */
import { seaTableRequest } from './_seatable.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

function parseMap(raw, label) {
  if (!String(raw || '').trim()) return {};
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch (_) { throw new Error(`${label} 必须是有效 JSON 对象`); }
}

const ORDER_DEFAULT_COLUMNS = { orderNo: '订单号', orderDate: '订单日期', sequenceNo: '序号', mealPeriod: '用餐时段', packageName: '套餐名称', price: '价格', mainMeat: '主荤', sideMeat: '副荤', name: '姓名', phone: '电话' };
const STATS_DEFAULT_COLUMNS = { orderNo: '订单号', orderDate: '订单日期', sequenceNo: '序号', mealPeriod: '用餐时段', dishGroup: '分组', dishName: '菜名', quantity: '份数', packageName: '套餐名称', name: '姓名', phone: '电话' };
function columnName(map, key) { return clean(map[key] || ORDER_DEFAULT_COLUMNS[key] || STATS_DEFAULT_COLUMNS[key] || key, 100) || key; }

function resolveMenuMap(rows, configured = {}) {
  const map = { ...configured };
  const sample = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row)) || {};
  const keys = Object.keys(sample).filter((key) => !key.startsWith('_'));
  const schema = ['type', 'key', 'name', 'price', 'mainCount', 'sideCount', 'group', 'sort', 'mealPeriod', 'value', 'enabled', 'published'];
  schema.forEach((key, index) => { if (!map[key] && keys[index]) map[key] = keys[index]; });
  return map;
}

async function seaTableFetch(env, tableName, method, row) {
  return seaTableRequest(env, tableName, method, row);
}

function beijingNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

function timeMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return NaN;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : NaN;
}

function defaultMealSchedule() {
  return { lunch: { label: '午餐', start: '00:00', end: '23:59' }, dinner: { label: '晚餐', start: '00:00', end: '23:59' } };
}

async function mealSchedule(env) {
  const defaults = defaultMealSchedule();
  if (String(env.MEAL_SCHEDULE_JSON || '').trim()) {
    try {
      const parsed = JSON.parse(env.MEAL_SCHEDULE_JSON);
      return parsed && typeof parsed === 'object' ? { ...defaults, ...parsed } : defaults;
    } catch (_) { return defaults; }
  }
  if (!clean(env.SEATABLE_MENU_TABLE_NAME, 100)) return defaults;
  try {
    const data = await seaTableFetch(env, env.SEATABLE_MENU_TABLE_NAME, 'GET');
    const menuMap = resolveMenuMap(rowsFromResponse(data), parseMap(env.SEATABLE_MENU_COLUMN_MAP, 'SEATABLE_MENU_COLUMN_MAP'));
    const settings = {};
    rowsFromResponse(data).forEach((row) => {
      const type = clean(row[columnName(menuMap, 'type')] ?? row.type ?? row.itemType ?? row['类型'], 30).toLowerCase();
      const key = clean(row[columnName(menuMap, 'key')] ?? row.key ?? row.settingKey ?? row['键'], 60);
      if ((type === 'setting' || type === '设置') && key) settings[key] = clean(row[columnName(menuMap, 'value')] ?? row.value ?? row.settingValue ?? row['值'], 100);
    });
    return {
      lunch: { label: '午餐', start: settings.lunchStart || defaults.lunch.start, end: settings.lunchEnd || defaults.lunch.end },
      dinner: { label: '晚餐', start: settings.dinnerStart || defaults.dinner.start, end: settings.dinnerEnd || defaults.dinner.end }
    };
  } catch (error) {
    throw new Error(`无法读取用餐时段配置：${error.message}`);
  }
}

function assertMealOpen(schedule, period, nowMinutes) {
  const item = schedule[period];
  if (!item) { const error = new Error('用餐时段无效'); error.status = 400; throw error; }
  const start = timeMinutes(item.start); const end = timeMinutes(item.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || nowMinutes < start || nowMinutes >= end) { const error = new Error(`${item.label || period}当前未开放，无法提交`); error.status = 400; throw error; }
}

function rowsFromResponse(data) { return Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []); }
function valueFrom(row, map, key, aliases = []) {
  let first;
  for (const name of [columnName(map, key), key, ...aliases]) {
    if (row?.[name] === undefined || row?.[name] === null) continue;
    if (first === undefined) first = row[name];
    if (typeof row[name] !== 'string' || row[name].trim() !== '') return row[name];
  }
  return first ?? '';
}
function dateOnly(value) { return String(value || '').slice(0, 10); }

function menuEnabled(value) {
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'is_checked')) return menuEnabled(value.is_checked);
    if (Object.prototype.hasOwnProperty.call(value, 'checked')) return menuEnabled(value.checked);
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return menuEnabled(value.value);
  }
  return !['0', 'false', 'no', 'off', '否', '停用', '下架'].includes(String(value ?? '').trim().toLowerCase());
}

function dishGroup(value) {
  const text = clean(value, 40).toLowerCase().replace(/\s+/g, '');
  if (text === 'mainmeat' || text.includes('主荤') || text.includes('主肉') || text.includes('主菜')) return 'main';
  if (text === 'sidemeat' || text.includes('副荤') || text.includes('半荤') || text.includes('副菜')) return 'side';
  return '';
}

async function readOrderMenu(env) {
  const tableName = clean(env.SEATABLE_MENU_TABLE_NAME, 100);
  if (!tableName) return null;
  const mapConfig = parseMap(env.SEATABLE_MENU_COLUMN_MAP, 'SEATABLE_MENU_COLUMN_MAP');
  const rows = rowsFromResponse(await seaTableFetch(env, tableName, 'GET'));
  const map = resolveMenuMap(rows, mapConfig);
  const menus = { lunch: { packages: [], mainMeat: new Set(), sideMeat: new Set() }, dinner: { packages: [], mainMeat: new Set(), sideMeat: new Set() } };
  const targets = (value) => { const key = clean(valueFrom(value, map, 'mealPeriod', ['餐段']), 20).toLowerCase(); return key === '午餐' || key === 'lunch' ? ['lunch'] : (key === '晚餐' || key === 'dinner' ? ['dinner'] : ['lunch', 'dinner']); };
  rows.forEach((row) => {
    const type = clean(valueFrom(row, map, 'type', ['类型', 'itemType']), 30).toLowerCase();
    const published = menuEnabled(valueFrom(row, map, 'published', ['上架', '发布状态']));
    const active = menuEnabled(valueFrom(row, map, 'enabled', ['启用', 'active']));
    if (!published || !active) return;
    if (type === 'package' || type === '套餐') targets(row).forEach((meal) => menus[meal].packages.push({
      name: clean(valueFrom(row, map, 'name', ['套餐名称', 'packageName']), 60),
      price: Number(valueFrom(row, map, 'price', ['价格'])),
      mainCount: Math.max(0, Math.floor(Number(valueFrom(row, map, 'mainCount', ['主荤数量', '主肉数量'])) || 0)),
      sideCount: Math.max(0, Math.floor(Number(valueFrom(row, map, 'sideCount', ['副荤数量', '半荤数量'])) || 0))
    }));
    if (type === 'dish' || type === '菜品') {
      const name = clean(valueFrom(row, map, 'name', ['菜名', '菜品名称']), 80);
      const group = clean(valueFrom(row, map, 'group', ['分组']), 30);
      const groupKind = dishGroup(group);
      targets(row).forEach((meal) => { if (groupKind === 'main') menus[meal].mainMeat.add(name); if (groupKind === 'side') menus[meal].sideMeat.add(name); });
    }
  });
  const hasMenu = Object.values(menus).some((meal) => meal.packages.length && meal.mainMeat.size && meal.sideMeat.size);
  // An empty table should not make every locally displayed order impossible
  // to submit. Normal validation resumes automatically once menu rows exist.
  if (!hasMenu) return null;
  return menus;
}

function validateOrderAgainstMenu(input, menu) {
  if (!menu) return;
  const scoped = menu[input.mealPeriod] || menu.lunch;
  const selectedPackage = scoped.packages.find((item) => item.name === input.packageName);
  if (!selectedPackage || !Number.isFinite(selectedPackage.price)) { const error = new Error('套餐已更新，请刷新页面后重新点餐'); error.status = 400; throw error; }
  const main = input.mainMeat.split('、').map((item) => item.trim()).filter(Boolean);
  const side = input.sideMeat.split('、').map((item) => item.trim()).filter(Boolean);
  if (main.length !== selectedPackage.mainCount || side.length !== selectedPackage.sideCount || main.some((item) => !scoped.mainMeat.has(item)) || side.some((item) => !scoped.sideMeat.has(item))) { const error = new Error('套餐或菜品已更新，请刷新页面后重新点餐'); error.status = 400; throw error; }
  input.price = selectedPackage.price;
}

async function nextDailySequence(env, tableName, map, today) {
  if (env.ORDER_DB && typeof env.ORDER_DB.prepare === 'function') {
    await env.ORDER_DB.prepare('CREATE TABLE IF NOT EXISTS daily_sequences (order_date TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL)').run();
    const row = await env.ORDER_DB.prepare('INSERT INTO daily_sequences (order_date, next_sequence) VALUES (?, 2) ON CONFLICT(order_date) DO UPDATE SET next_sequence = daily_sequences.next_sequence + 1 RETURNING next_sequence - 1 AS sequenceNo').bind(today).first();
    const sequence = Number(row?.sequenceNo);
    if (Number.isFinite(sequence) && sequence > 0) return sequence;
    throw new Error('无法生成当天订单序号');
  }
  const data = await seaTableFetch(env, tableName, 'GET'); let max = 0;
  rowsFromResponse(data).forEach((row) => {
    if (dateOnly(valueFrom(row, map, 'orderDate', ['日期'])) !== today) return;
    const explicit = Number(valueFrom(row, map, 'sequenceNo', ['序号', '订单序号']));
    const orderNo = String(valueFrom(row, map, 'orderNo', ['订单号']));
    const suffix = Number(orderNo.match(/-(\d{4})$/)?.[1] || 0);
    const sequence = Number.isFinite(explicit) && explicit > 0 ? explicit : suffix;
    if (sequence > max) max = sequence;
  });
  return max + 1;
}

async function peekDailySequence(env, tableName, map, today) {
  const data = await seaTableFetch(env, tableName, 'GET');
  let max = 0;
  rowsFromResponse(data).forEach((row) => {
    if (dateOnly(valueFrom(row, map, 'orderDate', ['日期'])) !== today) return;
    const explicit = Number(valueFrom(row, map, 'sequenceNo', ['序号', '订单序号']));
    const orderNo = String(valueFrom(row, map, 'orderNo', ['订单号']));
    const suffix = Number(orderNo.match(/-(\d{4})$/)?.[1] || 0);
    const sequence = Number.isFinite(explicit) && explicit > 0 ? explicit : suffix;
    if (sequence > max) max = sequence;
  });
  return max + 1;
}

function buildOrderRow(input, map, orderNo, orderDate, sequenceNo) {
  return {
    [columnName(map, 'orderNo')]: orderNo, [columnName(map, 'orderDate')]: orderDate,
    [columnName(map, 'sequenceNo')]: sequenceNo, [columnName(map, 'mealPeriod')]: input.mealPeriod,
    [columnName(map, 'packageName')]: input.packageName, [columnName(map, 'price')]: input.price,
    [columnName(map, 'mainMeat')]: input.mainMeat, [columnName(map, 'sideMeat')]: input.sideMeat,
    [columnName(map, 'name')]: input.name, [columnName(map, 'phone')]: input.phone
  };
}

function buildStatsRows(input, map, orderNo, orderDate, sequenceNo) {
  const result = [];
  const add = (value, group) => String(value || '').split('、').map((dish) => dish.trim()).filter(Boolean).forEach((dishName) => {
    result.push({
      [columnName(map, 'orderNo')]: orderNo, [columnName(map, 'orderDate')]: orderDate,
      [columnName(map, 'sequenceNo')]: sequenceNo, [columnName(map, 'mealPeriod')]: input.mealPeriod,
      [columnName(map, 'dishGroup')]: group, [columnName(map, 'dishName')]: dishName,
      [columnName(map, 'quantity')]: 1, [columnName(map, 'packageName')]: input.packageName,
      [columnName(map, 'name')]: input.name, [columnName(map, 'phone')]: input.phone
    });
  });
  add(input.mainMeat, '主荤'); add(input.sideMeat, '副荤'); return result;
}

export async function onRequestPost({ request, env }) {
  let raw;
  try { raw = await request.json(); } catch (_) { return json({ ok: false, error: '请求格式错误' }, 400); }
  const input = {
    packageName: clean(raw.packageName, 40), mealPeriod: clean(raw.mealPeriod, 20),
    mainMeat: clean(raw.mainMeat, 500), sideMeat: clean(raw.sideMeat, 500),
    name: clean(raw.name, 60), phone: clean(raw.phone, 30), price: Number(raw.price)
  };
  if (!input.packageName || !input.mealPeriod || !Number.isFinite(input.price) || !input.name || !/^1[3-9]\d{9}$/.test(input.phone)) return json({ ok: false, error: '订单信息不完整或格式不正确' }, 400);
  try {
    const orderMap = parseMap(env.SEATABLE_COLUMN_MAP, 'SEATABLE_COLUMN_MAP');
    const statsMap = parseMap(env.SEATABLE_STATS_COLUMN_MAP, 'SEATABLE_STATS_COLUMN_MAP');
    const now = beijingNow();
    assertMealOpen(await mealSchedule(env), input.mealPeriod, now.minutes);
    validateOrderAgainstMenu(input, await readOrderMenu(env));
    const orderTable = clean(env.SEATABLE_TABLE_NAME, 100); const statsTable = clean(env.SEATABLE_STATS_TABLE_NAME, 100);
    if (!orderTable || !statsTable) throw new Error('请配置订单表和菜品统计表名称');
    const sequenceNo = await nextDailySequence(env, orderTable, orderMap, now.date);
    const orderNo = `D${now.date.replace(/-/g, '').slice(2)}-${String(sequenceNo).padStart(4, '0')}`;
    await seaTableFetch(env, orderTable, 'POST', buildOrderRow(input, orderMap, orderNo, now.date, sequenceNo));
    for (const row of buildStatsRows(input, statsMap, orderNo, now.date, sequenceNo)) await seaTableFetch(env, statsTable, 'POST', row);
    return json({ ok: true, orderNo, sequenceNo, orderDate: now.date, mealPeriod: input.mealPeriod });
  } catch (error) {
    console.error('Order submit failed', error);
    return json({ ok: false, error: error.message || '订单提交失败' }, error.status || 502);
  }
}

export async function onRequest(context) {
  if (context.request.method === 'GET') {
    if (new URL(context.request.url).searchParams.get('preview') === '1') {
      try {
        const orderMap = parseMap(context.env.SEATABLE_COLUMN_MAP, 'SEATABLE_COLUMN_MAP');
        const tableName = clean(context.env.SEATABLE_TABLE_NAME, 100);
        if (!tableName) throw new Error('请配置订单表名称');
        const now = beijingNow();
        const sequenceNo = await peekDailySequence(context.env, tableName, orderMap, now.date);
        // 生成订单阶段只展示当天取餐序号，正式提交时再由服务端生成最终订单号。
        return json({ ok: true, orderNo: String(sequenceNo), sequenceNo, orderDate: now.date, provisional: true });
      } catch (error) {
        return json({ ok: false, error: error.message || '无法获取当前订单号' }, 502);
      }
    }
    const configured = Boolean(clean(context.env?.SEATABLE_BASE_UUID) && clean(context.env?.SEATABLE_BASE_TOKEN) && clean(context.env?.SEATABLE_TABLE_NAME) && clean(context.env?.SEATABLE_STATS_TABLE_NAME));
    return json({ ok: true, service: 'order', configured });
  }
  if (context.request.method !== 'POST') return json({ ok: false, error: 'Method Not Allowed' }, 405);
  return onRequestPost(context);
}
