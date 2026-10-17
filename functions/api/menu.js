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

const field = (row, ...names) => {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null) return row[name];
  }
  return '';
};

const enabled = (value) => !['0', 'false', 'no', 'off', '否', '停用', '下架'].includes(String(value ?? '').trim().toLowerCase());

function isPublished(row, map) {
  const status = field(row, columnName(map, 'published'), 'published', 'publish', '上架', '发布状态');
  const enabledValue = field(row, columnName(map, 'enabled'), 'enabled', 'active', '启用');
  return enabled(status) && enabled(enabledValue);
}

const numberOr = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

async function readRows(env) {
  const baseUuid = clean(env.SEATABLE_BASE_UUID, 120);
  const token = clean(env.SEATABLE_BASE_TOKEN, 300);
  const tableName = clean(env.SEATABLE_MENU_TABLE_NAME, 100);
  if (!baseUuid || !token || !tableName) throw new Error('服务端尚未配置菜单表参数');

  const origin = String(env.SEATABLE_API_ORIGIN || 'https://cloud.seatable.cn').replace(/\/$/, '');
  const query = new URLSearchParams({ table_name: tableName, limit: '1000' });
  const endpoint = `${origin}/api-gateway/api/v2/dtables/${encodeURIComponent(baseUuid)}/rows/?${query}`;
  const scheme = String(env.SEATABLE_AUTH_SCHEME || 'Bearer').trim() || 'Bearer';
  const response = await fetch(endpoint, { headers: { Authorization: `${scheme} ${token}` } });
  const text = await response.text();
  if (!response.ok) {
    let reason = '';
    try {
      const parsed = JSON.parse(text);
      reason = clean(parsed.error || parsed.message || parsed.detail, 180);
    } catch (_) { /* plain text response */ }
    throw new Error(reason ? `菜单读取失败：${reason}` : `菜单读取失败（HTTP ${response.status}）`);
  }
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('菜单接口返回格式错误'); }
  return Array.isArray(data) ? data : (Array.isArray(data.rows) ? data.rows : []);
}

function buildMenu(rows, map) {
  const mealMenus = { lunch: { packages: {}, mainMeat: [], sideMeat: [] }, dinner: { packages: {}, mainMeat: [], sideMeat: [] } };
  const settings = {};
  const mealTargets = (value) => {
    const key = clean(value, 20).toLowerCase();
    if (key === 'lunch' || key === '午餐') return ['lunch'];
    if (key === 'dinner' || key === '晚餐') return ['dinner'];
    return ['lunch', 'dinner'];
  };

  rows.forEach((row, index) => {
    const type = clean(field(row, columnName(map, 'type'), 'type', 'itemType', '类型'), 30).toLowerCase();
    if (!isPublished(row, map)) return;
    if (type === 'setting' || type === '设置') {
      const key = clean(field(row, columnName(map, 'key'), 'key', 'settingKey', '键'), 80);
      if (key) settings[key] = clean(field(row, columnName(map, 'value'), 'value', 'settingValue', '值'), 500);
      return;
    }
    if (type === 'package' || type === '套餐') {
      const key = clean(field(row, columnName(map, 'key'), 'key', 'packageKey', '套餐键'), 20);
      const name = clean(field(row, columnName(map, 'name'), 'name', 'packageName', '套餐名称'), 60);
      if (!key || !name) return;
      const item = {
        name,
        price: numberOr(field(row, columnName(map, 'price'), 'price', '价格'), 0),
        mainCount: Math.max(0, Math.floor(numberOr(field(row, columnName(map, 'mainCount'), 'mainCount', '主荤数量', '主肉数量'), 0))),
        sideCount: Math.max(0, Math.floor(numberOr(field(row, columnName(map, 'sideCount'), 'sideCount', '副荤数量', '半荤数量'), 0)))
      };
      mealTargets(field(row, columnName(map, 'mealPeriod'), 'mealPeriod', '餐段')).forEach((meal) => { mealMenus[meal].packages[key] = item; });
      return;
    }
    if (type === 'dish' || type === '菜品') {
      const name = clean(field(row, columnName(map, 'name'), 'name', 'dishName', '菜品名称'), 80);
      const group = clean(field(row, columnName(map, 'group'), 'group', 'dishGroup', '分组'), 30);
      if (!name || (group !== 'mainMeat' && group !== 'sideMeat' && group !== '主肉' && group !== '半荤' && group !== '主荤' && group !== '副荤')) return;
      const item = { name, sort: numberOr(field(row, columnName(map, 'sort'), 'sort', '排序'), index) };
      mealTargets(field(row, columnName(map, 'mealPeriod'), 'mealPeriod', '餐段')).forEach((meal) => {
        if (group === 'mainMeat' || group === '主肉' || group === '主荤') mealMenus[meal].mainMeat.push(item);
        else mealMenus[meal].sideMeat.push(item);
      });
    }
  });

  Object.values(mealMenus).forEach((meal) => { meal.mainMeat.sort((a, b) => a.sort - b.sort); meal.sideMeat.sort((a, b) => a.sort - b.sort); meal.dishes = { mainMeat: meal.mainMeat.map((item) => item.name), sideMeat: meal.sideMeat.map((item) => item.name) }; delete meal.mainMeat; delete meal.sideMeat; });
  const fallback = mealMenus.lunch;
  const result = {
    packages: fallback.packages,
    dishes: fallback.dishes,
    mealMenus,
    mealSchedule: {
      lunch: { label: '午餐', start: settings.lunchStart || '00:00', end: settings.lunchEnd || '10:30' },
      dinner: { label: '晚餐', start: settings.dinnerStart || '12:00', end: settings.dinnerEnd || '16:00' }
    },
    contactName: settings.contactName || '',
    contactPhone: settings.contactPhone || '',
    soupNotice: settings.soupNotice || '',
    giftDish: settings.giftDish || '',
    orderingNotice: settings.orderingNotice || '',
    orderDeadline: settings.orderDeadline || null
  };
  if (!Object.keys(mealMenus.lunch.packages).length && !Object.keys(mealMenus.dinner.packages).length) throw new Error('菜单表中没有启用的套餐');
  if ((!mealMenus.lunch.dishes.mainMeat.length || !mealMenus.lunch.dishes.sideMeat.length) && (!mealMenus.dinner.dishes.mainMeat.length || !mealMenus.dinner.dishes.sideMeat.length)) throw new Error('菜单表中没有启用的菜品');
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
