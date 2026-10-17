/** Cloudflare Pages order endpoint. */

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

function columnName(map, key) { return clean(map[key] || key, 100) || key; }

function apiConfig(env) {
  const baseUuid = clean(env.SEATABLE_BASE_UUID, 120);
  const token = clean(env.SEATABLE_BASE_TOKEN, 300);
  if (!baseUuid || !token) throw new Error('服务端尚未配置 SeaTable 参数');
  return {
    baseUuid,
    token,
    origin: String(env.SEATABLE_API_ORIGIN || 'https://cloud.seatable.cn').replace(/\/$/, ''),
    scheme: String(env.SEATABLE_AUTH_SCHEME || 'Bearer').trim() || 'Bearer'
  };
}

async function seaTableFetch(env, tableName, method, row) {
  const config = apiConfig(env);
  const table = clean(tableName, 100);
  if (!table) throw new Error('未配置 SeaTable 表名');
  const query = new URLSearchParams({ table_name: table });
  if (method === 'GET') query.set('limit', '1000');
  const endpoint = `${config.origin}/api-gateway/api/v2/dtables/${encodeURIComponent(config.baseUuid)}/rows/?${query}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: { Authorization: `${config.scheme} ${config.token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ table_name: table, row }) : undefined
    });
  } catch (_) { throw new Error('无法连接 SeaTable'); }
  const text = await response.text();
  if (!response.ok) {
    let reason = '';
    try { const parsed = JSON.parse(text); reason = clean(parsed.error || parsed.message || parsed.detail, 180); } catch (_) { }
    throw new Error(reason ? `SeaTable 请求失败：${reason}` : `SeaTable 请求失败（HTTP ${response.status}）`);
  }
  try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
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
  return { lunch: { label: '午餐', start: '00:00', end: '10:30' }, dinner: { label: '晚餐', start: '12:00', end: '16:00' } };
}

async function mealSchedule(env) {
  return defaultMealSchedule();
  /*
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
    const settings = {};
    rowsFromResponse(data).forEach((row) => {
      const type = clean(row.type || row.itemType || row['类型'], 30).toLowerCase();
      const key = clean(row.key || row.settingKey || row['键'], 60);
      if ((type === 'setting' || type === '设置') && key) settings[key] = clean(row.value || row.settingValue || row['值'], 100);
    });
    return {
      lunch: { label: '午餐', start: settings.lunchStart || defaults.lunch.start, end: settings.lunchEnd || defaults.lunch.end },
      dinner: { label: '晚餐', start: settings.dinnerStart || defaults.dinner.start, end: settings.dinnerEnd || defaults.dinner.end }
    };
  } catch (error) {
    throw new Error(`无法读取用餐时段配置：${error.message}`);
  }
  */
}

function assertMealOpen(schedule, period, nowMinutes) {
  const item = schedule[period];
  if (!item) { const error = new Error('用餐时段无效'); error.status = 400; throw error; }
  const start = timeMinutes(item.start); const end = timeMinutes(item.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || nowMinutes < start || nowMinutes >= end) { const error = new Error(`${item.label || period}当前未开放，无法提交`); error.status = 400; throw error; }
}

function rowsFromResponse(data) { return Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []); }
function valueFrom(row, map, key, aliases = []) {
  for (const name of [columnName(map, key), key, ...aliases]) if (row?.[name] !== undefined && row?.[name] !== null) return row[name];
  return '';
}
function dateOnly(value) { return String(value || '').slice(0, 10); }

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
  if (!input.packageName || !input.mealPeriod || !Number.isFinite(input.price) || !input.mainMeat || !input.sideMeat || !input.name || !/^1[3-9]\d{9}$/.test(input.phone)) return json({ ok: false, error: '订单信息不完整或格式不正确' }, 400);
  try {
    const orderMap = parseMap(env.SEATABLE_COLUMN_MAP, 'SEATABLE_COLUMN_MAP');
    const statsMap = parseMap(env.SEATABLE_STATS_COLUMN_MAP, 'SEATABLE_STATS_COLUMN_MAP');
    const now = beijingNow();
    assertMealOpen(await mealSchedule(env), input.mealPeriod, now.minutes);
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
