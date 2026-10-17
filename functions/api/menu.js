/**
 * Public menu configuration endpoint.
 * The SeaTable token stays in Cloudflare Pages variables; only validated menu
 * data is returned to the browser.
 *
 * Required variables:
 *   SEATABLE_BASE_UUID
 *   SEATABLE_BASE_TOKEN
 *   SEATABLE_MENU_TABLE_NAME  (for example: 菜单配置)
 * Optional:
 *   SEATABLE_API_ORIGIN       Defaults to https://cloud.seatable.cn
 *   SEATABLE_AUTH_SCHEME      Bearer (default) or Token
 */
import { seaTableRequest } from './_seatable.js';

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
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

function columnName(map, key) { return clean(map[key] || key, 100) || key; }

function resolveMenuMap(rows, configured = {}) {
  const map = { ...configured };
  const sample = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row)) || {};
  const keys = Object.keys(sample).filter((key) => !key.startsWith('_'));
  // Some SeaTable API versions return internal column IDs (for example
  // `0000`, `P0Ac`) instead of the visible Chinese column names. Infer those
  // IDs from their values so the public menu stays compatible with either API.
  const allValues = (key) => rows.map((row) => row?.[key]).filter((value) => value !== undefined && value !== null).map((value) => String(value).trim());
  const score = (key, kind) => {
    const values = allValues(key); let result = 0;
    values.forEach((value) => {
      const lower = value.toLowerCase();
      if (kind === 'type' && ['套餐', 'package', '菜品', 'dish', '设置', 'setting'].includes(lower)) result += 10;
      if (kind === 'group' && ['主荤', '副荤', '主肉', '半荤', 'mainmeat', 'sidemeat'].includes(lower)) result += 8;
      if (kind === 'mealPeriod' && ['全部', '午餐', '晚餐', 'all', 'lunch', 'dinner'].includes(lower)) result += 8;
      if (kind === 'settingKey' && ['contactname', 'contactphone', 'lunchstart', 'lunchend', 'dinnerstart', 'dinnerend'].includes(lower)) result += 9;
      if (kind === 'bool' && ['true', 'false', '是', '否', '1', '0'].includes(lower)) result += 2;
    });
    return result;
  };
  const infer = (name, kind) => {
    if (map[name]) return;
    const choice = keys.filter((key) => !Object.values(map).includes(key)).sort((a, b) => score(b, kind) - score(a, kind))[0];
    if (choice && score(choice, kind) > 0) map[name] = choice;
  };
  infer('type', 'type'); infer('group', 'group'); infer('mealPeriod', 'mealPeriod'); infer('key', 'settingKey');
  // If a field has no distinctive values, use the table's declared order as a
  // final fallback (the documented menu schema order).
  const schema = ['type', 'key', 'name', 'price', 'mainCount', 'sideCount', 'group', 'sort', 'mealPeriod', 'value', 'enabled', 'published'];
  keys.forEach((column, index) => { const name = schema[index]; if (name && !map[name]) map[name] = column; });
  return map;
}

const field = (row, ...names) => {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null) return row[name];
  }
  return '';
};

function enabled(value) {
  // SeaTable checkbox values can be booleans, 0/1, strings, or (depending
  // on the API version) a small object containing the checked value.
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'is_checked')) return enabled(value.is_checked);
    if (Object.prototype.hasOwnProperty.call(value, 'checked')) return enabled(value.checked);
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return enabled(value.value);
  }
  return !['0', 'false', 'no', 'off', '否', '停用', '下架'].includes(String(value ?? '').trim().toLowerCase());
}

function fieldValue(row, names) {
  let first;
  for (const name of names) {
    if (!row || row[name] === undefined || row[name] === null) continue;
    if (first === undefined) first = row[name];
    // Prefer a non-empty alias when a stale/hidden column with the same
    // semantic name is present in the returned row.
    if (typeof row[name] !== 'string' || row[name].trim() !== '') return row[name];
  }
  return first ?? '';
}

function isPublished(row, map) {
  const status = fieldValue(row, [columnName(map, 'published'), 'published', 'publish', '上架', '发布状态']);
  const enabledValue = fieldValue(row, [columnName(map, 'enabled'), 'enabled', 'active', '启用']);
  return enabled(status) && enabled(enabledValue);
}

const numberOr = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

async function readRows(env) {
  const tableName = clean(env.SEATABLE_MENU_TABLE_NAME, 100);
  if (!tableName) throw new Error('服务端尚未配置菜单表参数');
  const data = await seaTableRequest(env, tableName, 'GET');
  return Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : []);
}

function buildMenu(rows, map) {
  map = resolveMenuMap(rows, map);
  const mealMenus = { lunch: { packages: {}, mainMeat: [], sideMeat: [] }, dinner: { packages: {}, mainMeat: [], sideMeat: [] } };
  const settings = {};
  const diagnostics = { rows: rows.length, settings: 0, packages: 0, dishes: 0, hidden: 0, unknown: 0, unknownTypes: [], sampleKeys: Object.keys(rows[0] || {}).slice(0, 20), sampleKind: Array.isArray(rows[0]) ? 'array' : typeof rows[0] };
  const mealTargets = (value) => {
    const key = clean(value, 20).toLowerCase();
    if (key === 'lunch' || key === '午餐') return ['lunch'];
    if (key === 'dinner' || key === '晚餐') return ['dinner'];
    return ['lunch', 'dinner'];
  };

  rows.forEach((row, index) => {
    const type = clean(fieldValue(row, [columnName(map, 'type'), 'type', 'itemType', '类型']), 30).toLowerCase();
    if (type === 'setting' || type === '设置') {
      diagnostics.settings += 1;
      // Settings (contact and schedule) are configuration, not menu items;
      // do not hide them just because an old row has an unchecked status.
      const key = clean(fieldValue(row, [columnName(map, 'key'), 'key', 'settingKey', '键']), 80);
      const value = clean(fieldValue(row, [columnName(map, 'value'), 'value', 'settingValue', '值']), 500);
      // Keep a valid value when old failed saves left duplicate setting rows.
      if (key && (value || !settings[key])) settings[key] = value;
      return;
    }
    if (!isPublished(row, map)) { diagnostics.hidden += 1; return; }
    if (type === 'package' || type === '套餐') {
      diagnostics.packages += 1;
      const key = clean(fieldValue(row, [columnName(map, 'key'), 'key', 'packageKey', '套餐键']), 20);
      const name = clean(fieldValue(row, [columnName(map, 'name'), 'name', 'packageName', '套餐名称']), 60);
      if (!key || !name) return;
      const item = {
        name,
        price: numberOr(fieldValue(row, [columnName(map, 'price'), 'price', '价格']), 0),
        mainCount: Math.max(0, Math.floor(numberOr(fieldValue(row, [columnName(map, 'mainCount'), 'mainCount', '主荤数量', '主肉数量']), 0))),
        sideCount: Math.max(0, Math.floor(numberOr(fieldValue(row, [columnName(map, 'sideCount'), 'sideCount', '副荤数量', '半荤数量']), 0)))
      };
      mealTargets(fieldValue(row, [columnName(map, 'mealPeriod'), 'mealPeriod', '餐段'])).forEach((meal) => { mealMenus[meal].packages[key] = item; });
      return;
    }
    if (type === 'dish' || type === '菜品') {
      diagnostics.dishes += 1;
      const name = clean(fieldValue(row, [columnName(map, 'name'), 'name', 'dishName', '菜品名称']), 80);
      const group = clean(fieldValue(row, [columnName(map, 'group'), 'group', 'dishGroup', '分组']), 30);
      if (!name || (group !== 'mainMeat' && group !== 'sideMeat' && group !== '主肉' && group !== '半荤' && group !== '主荤' && group !== '副荤')) return;
      const item = { name, sort: numberOr(fieldValue(row, [columnName(map, 'sort'), 'sort', '排序']), index) };
      mealTargets(fieldValue(row, [columnName(map, 'mealPeriod'), 'mealPeriod', '餐段'])).forEach((meal) => {
        if (group === 'mainMeat' || group === '主肉' || group === '主荤') mealMenus[meal].mainMeat.push(item);
        else mealMenus[meal].sideMeat.push(item);
      });
      return;
    }
    diagnostics.unknown += 1;
    if (diagnostics.unknownTypes.length < 8 && type) diagnostics.unknownTypes.push(type);
  });

  Object.values(mealMenus).forEach((meal) => { meal.mainMeat.sort((a, b) => a.sort - b.sort); meal.sideMeat.sort((a, b) => a.sort - b.sort); meal.dishes = { mainMeat: meal.mainMeat.map((item) => item.name), sideMeat: meal.sideMeat.map((item) => item.name) }; delete meal.mainMeat; delete meal.sideMeat; });
  const fallback = mealMenus.lunch;
  const result = {
    packages: fallback.packages,
    dishes: fallback.dishes,
    mealMenus,
    mealSchedule: {
      // If no setting row exists yet, keep the page usable all day. Once the
      // merchant saves a schedule, these values are replaced by that setting.
      lunch: { label: '午餐', start: settings.lunchStart || '00:00', end: settings.lunchEnd || '23:59' },
      dinner: { label: '晚餐', start: settings.dinnerStart || '00:00', end: settings.dinnerEnd || '23:59' }
    },
    contactName: settings.contactName || '',
    contactPhone: settings.contactPhone || '',
    orderingNotice: settings.orderingNotice || '',
    orderDeadline: settings.orderDeadline || null
  };
  const warnings = [];
  if (!Object.keys(mealMenus.lunch.packages).length && !Object.keys(mealMenus.dinner.packages).length) warnings.push('菜单表中没有启用的套餐');
  if ((!mealMenus.lunch.dishes.mainMeat.length || !mealMenus.lunch.dishes.sideMeat.length) && (!mealMenus.dinner.dishes.mainMeat.length || !mealMenus.dinner.dishes.sideMeat.length)) warnings.push('菜单表中没有启用的菜品');
  if (warnings.length) warnings.push(`诊断：读取 ${diagnostics.rows} 行，设置 ${diagnostics.settings} 条，套餐 ${diagnostics.packages} 条，菜品 ${diagnostics.dishes} 条，被隐藏 ${diagnostics.hidden} 条，未知类型 ${diagnostics.unknown} 条${diagnostics.unknownTypes.length ? `（${diagnostics.unknownTypes.join('、')}）` : ''}；数据类型：${diagnostics.sampleKind}；字段：${diagnostics.sampleKeys.join('、') || '无'}`);
  if (warnings.length) result.menuWarning = warnings.join('；');
  return result;
}

export async function onRequestGet({ env }) {
  try {
    const map = parseMap(env.SEATABLE_MENU_COLUMN_MAP, 'SEATABLE_MENU_COLUMN_MAP');
    const menu = buildMenu(await readRows(env), map);
    return json({ ok: true, ...menu }, 200, { 'cache-control': 'no-store' });
  } catch (error) {
    console.error('Menu read failed', error);
    return json({ ok: false, error: error.message || '菜单读取失败' }, 502, { 'cache-control': 'no-store' });
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') return json({ ok: false, error: 'Method Not Allowed' }, 405);
  return onRequestGet(context);
}
