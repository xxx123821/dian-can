const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const bool = (value) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || !['0', 'false', 'no', 'off', '否', '停用', '下架'].includes(String(value ?? '').trim().toLowerCase());

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS packages (id INTEGER PRIMARY KEY AUTOINCREMENT, meal_period TEXT NOT NULL DEFAULT '全部', package_key TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, main_count INTEGER NOT NULL DEFAULT 0, side_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1, UNIQUE(package_key, meal_period));
CREATE TABLE IF NOT EXISTS dishes (id INTEGER PRIMARY KEY AUTOINCREMENT, meal_period TEXT NOT NULL DEFAULT '全部', dish_key TEXT NOT NULL, name TEXT NOT NULL, dish_group TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1, UNIQUE(dish_key, meal_period));
CREATE TABLE IF NOT EXISTS daily_sequences (order_date TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL DEFAULT 1, archived_through INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_date TEXT NOT NULL, sequence_no INTEGER NOT NULL, order_no TEXT NOT NULL UNIQUE, meal_period TEXT NOT NULL, package_name TEXT NOT NULL, price REAL NOT NULL, main_meat TEXT NOT NULL DEFAULT '', side_meat TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, phone TEXT NOT NULL, submitted_at TEXT NOT NULL, UNIQUE(order_date, sequence_no));
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, order_date TEXT NOT NULL, sequence_no INTEGER NOT NULL, meal_period TEXT NOT NULL, dish_group TEXT NOT NULL, dish_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, package_name TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', FOREIGN KEY(order_id) REFERENCES orders(id));
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date, sequence_no);
CREATE INDEX IF NOT EXISTS idx_items_date ON order_items(order_date, meal_period, dish_name);
`;
let schemaPromise;
export function d1Enabled(env) { return Boolean(env?.DB && typeof env.DB.prepare === 'function'); }
export async function ensureD1(db) { if (!schemaPromise) schemaPromise = db.exec(SCHEMA); await schemaPromise; }
let cleanupPromise;
let lastCleanupDate = '';
const HISTORY_DAYS = 7;
function dateBeforeToday(days) {
  const today = beijingDate();
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}
// Keep only the latest seven Beijing calendar dates. Cleanup is triggered by
// normal D1 traffic and runs at most once per Beijing date per Worker isolate.
export async function cleanupD1OldData(db) {
  const today = beijingDate();
  if (cleanupPromise) return cleanupPromise;
  if (lastCleanupDate === today) return null;
  cleanupPromise = (async () => {
    await ensureD1(db);
    const cutoff = dateBeforeToday(HISTORY_DAYS - 1);
    await db.batch([
      db.prepare('DELETE FROM order_items WHERE order_date < ?').bind(cutoff),
      db.prepare('DELETE FROM orders WHERE order_date < ?').bind(cutoff),
      db.prepare('DELETE FROM daily_sequences WHERE order_date < ?').bind(cutoff)
    ]);
    lastCleanupDate = today;
    return { cutoff, historyDays: HISTORY_DAYS };
  })().finally(() => { cleanupPromise = null; });
  return cleanupPromise;
}
export function beijingDate() { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); const get = (type) => parts.find((part) => part.type === type)?.value || ''; return `${get('year')}-${get('month')}-${get('day')}`; }
export function beijingIso() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(' ', 'T'); }
function targets(value) { const key = clean(value, 20).toLowerCase(); return key === '午餐' || key === 'lunch' ? ['lunch'] : (key === '晚餐' || key === 'dinner' ? ['dinner'] : ['lunch', 'dinner']); }
function mealLabel(key) { return key === 'dinner' ? '晚餐' : '午餐'; }
function itemMeal(value) { const key = clean(value, 20).toLowerCase(); return key === 'lunch' || key === '午餐' ? '午餐' : key === 'dinner' || key === '晚餐' ? '晚餐' : '全部'; }

export async function readD1Config(db) {
  await ensureD1(db);
  const [packages, dishes, settings] = await Promise.all([
    db.prepare('SELECT id, meal_period AS mealPeriod, package_key AS packageKey, name, price, main_count AS mainCount, side_count AS sideCount, enabled, published FROM packages ORDER BY package_key, id').all(),
    db.prepare('SELECT id, meal_period AS mealPeriod, dish_key AS dishKey, name, dish_group AS dishGroup, sort, enabled, published FROM dishes ORDER BY sort, id').all(),
    db.prepare('SELECT key, value, enabled, published FROM settings').all()
  ]);
  return { packages: packages.results || [], dishes: dishes.results || [], settings: settings.results || [] };
}

export function adminMenu(config) {
  const settings = {}; (config.settings || []).forEach((row) => { settings[row.key] = { id: '', key: row.key, value: clean(row.value), enabled: bool(row.enabled), published: bool(row.published) }; });
  return {
    packages: (config.packages || []).map((row) => ({ id: String(row.id), type: 'package', mealPeriod: row.mealPeriod || '全部', key: row.packageKey, name: row.name, price: Number(row.price) || 0, mainCount: Number(row.mainCount) || 0, sideCount: Number(row.sideCount) || 0, enabled: bool(row.enabled), published: bool(row.published) })),
    dishes: (config.dishes || []).map((row) => ({ id: String(row.id), type: 'dish', mealPeriod: row.mealPeriod || '全部', key: row.dishKey, name: row.name, group: row.dishGroup, sort: Number(row.sort) || 0, enabled: bool(row.enabled), published: bool(row.published) })),
    settings
  };
}

export function publicMenu(config) {
  const mealMenus = { lunch: { packages: {}, dishes: { mainMeat: [], sideMeat: [] } }, dinner: { packages: {}, dishes: { mainMeat: [], sideMeat: [] } } };
  const settings = {}; (config.settings || []).forEach((row) => { if (row.key) settings[row.key] = clean(row.value); });
  (config.packages || []).filter((row) => bool(row.enabled) && bool(row.published)).forEach((row) => targets(row.mealPeriod).forEach((meal) => { mealMenus[meal].packages[row.packageKey] = { name: clean(row.name, 60), price: Number(row.price) || 0, mainCount: Math.max(0, Number(row.mainCount) || 0), sideCount: Math.max(0, Number(row.sideCount) || 0) }; }));
  (config.dishes || []).filter((row) => bool(row.enabled) && bool(row.published) && clean(row.name)).forEach((row) => targets(row.mealPeriod).forEach((meal) => { const group = clean(row.dishGroup, 30); const target = /副荤|半荤|side/i.test(group) ? mealMenus[meal].dishes.sideMeat : /主荤|主肉|main/i.test(group) ? mealMenus[meal].dishes.mainMeat : null; if (target && !target.includes(row.name)) target.push(row.name); }));
  const fallback = mealMenus.lunch;
  const result = { packages: fallback.packages, dishes: fallback.dishes, mealMenus, mealSchedule: { lunch: { label: '午餐', start: settings.lunchStart || '00:00', end: settings.lunchEnd || '23:59' }, dinner: { label: '晚餐', start: settings.dinnerStart || '00:00', end: settings.dinnerEnd || '23:59' } }, contactName: settings.contactName || '', contactPhone: settings.contactPhone || '', orderingNotice: settings.orderingNotice || '', orderDeadline: settings.orderDeadline || null };
  const warnings = []; if (!Object.keys(mealMenus.lunch.packages).length && !Object.keys(mealMenus.dinner.packages).length) warnings.push('菜单表中没有启用的套餐'); if ((!fallback.dishes.mainMeat.length || !fallback.dishes.sideMeat.length) && (!mealMenus.dinner.dishes.mainMeat.length || !mealMenus.dinner.dishes.sideMeat.length)) warnings.push('菜单表中没有启用的菜品'); if (warnings.length) result.menuWarning = warnings.join('；'); return result;
}

function rowValue(item, key, fallback = '') { return item?.[key] ?? fallback; }
function writeValue(value) { return value === true ? 1 : value === false ? 0 : value; }
async function batch(db, statements, size = 50) { for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size)); }
export async function saveD1Menu(db, payload) {
  await ensureD1(db); const statements = [];
  for (const item of [...(payload.packages || []), ...(payload.dishes || [])]) {
    if (!clean(item.name, 100) || !clean(item.key, 80)) continue;
    if (item.type === 'package') { const values = [clean(item.mealPeriod) || '全部', clean(item.key, 80), clean(item.name, 100), Number(item.price) || 0, Math.max(0, Number(item.mainCount) || 0), Math.max(0, Number(item.sideCount) || 0), writeValue(Boolean(item.enabled)), writeValue(Boolean(item.published))]; statements.push(item.id && /^\d+$/.test(String(item.id)) ? db.prepare('UPDATE packages SET meal_period=?, package_key=?, name=?, price=?, main_count=?, side_count=?, enabled=?, published=? WHERE id=?').bind(...values, Number(item.id)) : db.prepare('INSERT INTO packages (meal_period, package_key, name, price, main_count, side_count, enabled, published) VALUES (?,?,?,?,?,?,?,?)').bind(...values)); }
    else { const values = [clean(item.mealPeriod) || '全部', clean(item.key, 80), clean(item.name, 100), clean(item.group, 30), Number(item.sort) || 0, writeValue(Boolean(item.enabled)), writeValue(Boolean(item.published))]; statements.push(item.id && /^\d+$/.test(String(item.id)) ? db.prepare('UPDATE dishes SET meal_period=?, dish_key=?, name=?, dish_group=?, sort=?, enabled=?, published=? WHERE id=?').bind(...values, Number(item.id)) : db.prepare('INSERT INTO dishes (meal_period, dish_key, name, dish_group, sort, enabled, published) VALUES (?,?,?,?,?,?,?)').bind(...values)); }
  }
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
  for (const key of ['contactName', 'contactPhone', 'lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd']) statements.push(db.prepare('INSERT INTO settings (key, value, enabled, published) VALUES (?, ?, 1, 1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, enabled=1, published=1').bind(key, clean(settings[key], 500)));
  await batch(db, statements); return adminMenu(await readD1Config(db));
}
export async function saveD1Settings(db, settings) { return saveD1Menu(db, { packages: [], dishes: [], settings }); }

function clockMinutes(value) { const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/); if (!match) return NaN; return Number(match[1]) * 60 + Number(match[2]); }
export function d1Schedule(config) { const settings = {}; (config.settings || []).forEach((row) => { settings[row.key] = clean(row.value); }); return { lunch: { label: '午餐', start: settings.lunchStart || '00:00', end: settings.lunchEnd || '23:59' }, dinner: { label: '晚餐', start: settings.dinnerStart || '00:00', end: settings.dinnerEnd || '23:59' } }; }
export function assertD1MealOpen(schedule, period, minutes) { const item = schedule[period]; const start = clockMinutes(item?.start); const end = clockMinutes(item?.end); if (!item || !Number.isFinite(start) || !Number.isFinite(end) || minutes < start || minutes >= end) throw Object.assign(new Error(`${item?.label || period}当前未开放，无法提交`), { status: 400 }); }
export function validateD1Order(input, config) { const menu = publicMenu(config).mealMenus?.[input.mealPeriod]; const pkg = menu?.packages?.[input.packageName] || Object.values(menu?.packages || {}).find((item) => item.name === input.packageName); if (!pkg) throw Object.assign(new Error('套餐已更新，请刷新页面后重新点餐'), { status: 400 }); const main = input.mainMeat.split('、').filter(Boolean); const side = input.sideMeat.split('、').filter(Boolean); if (main.length !== pkg.mainCount || side.length !== pkg.sideCount || main.some((name) => !menu.dishes.mainMeat.includes(name)) || side.some((name) => !menu.dishes.sideMeat.includes(name))) throw Object.assign(new Error('套餐或菜品已更新，请刷新页面后重新点餐'), { status: 400 }); input.price = pkg.price; }

export async function nextD1Sequence(db, date) { const row = await db.prepare('INSERT INTO daily_sequences (order_date, next_sequence) VALUES (?, 2) ON CONFLICT(order_date) DO UPDATE SET next_sequence = daily_sequences.next_sequence + 1 RETURNING next_sequence - 1 AS sequenceNo').bind(date).first(); const sequence = Number(row?.sequenceNo); if (!Number.isFinite(sequence) || sequence < 1) throw new Error('无法生成当天取餐号'); return sequence; }
export async function peekD1Sequence(db, date) { const row = await db.prepare('SELECT next_sequence FROM daily_sequences WHERE order_date=?').bind(date).first(); return Math.max(1, Number(row?.next_sequence) || 1); }
export async function insertD1Order(db, input, date, sequenceNo) { const orderNo = `D${date.replace(/-/g, '').slice(2)}-${String(sequenceNo).padStart(4, '0')}`; const submittedAt = beijingIso(); const order = await db.prepare('INSERT INTO orders (order_date, sequence_no, order_no, meal_period, package_name, price, main_meat, side_meat, name, phone, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(date, sequenceNo, orderNo, input.mealPeriod, input.packageName, input.price, input.mainMeat, input.sideMeat, input.name, input.phone, submittedAt).run(); const orderId = order.meta?.last_row_id; const rows = []; const add = (value, group) => String(value || '').split('、').map((name) => name.trim()).filter(Boolean).forEach((dishName) => rows.push(db.prepare('INSERT INTO order_items (order_id, order_date, sequence_no, meal_period, dish_group, dish_name, quantity, package_name, name, phone) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(orderId, date, sequenceNo, input.mealPeriod, group, dishName, 1, input.packageName, input.name, input.phone))); add(input.mainMeat, '主荤'); add(input.sideMeat, '副荤'); if (!input.mainMeat && !input.sideMeat && /减脂餐/.test(input.packageName)) rows.push(db.prepare('INSERT INTO order_items (order_id, order_date, sequence_no, meal_period, dish_group, dish_name, quantity, package_name, name, phone) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(orderId, date, sequenceNo, input.mealPeriod, '套餐', '减脂餐', 1, input.packageName, input.name, input.phone)); if (rows.length) await db.batch(rows); return { orderNo, orderDate: date, sequenceNo, mealPeriod: input.mealPeriod }; }

export async function readD1Live(db, date, includeArchived = false) { await ensureD1(db); const today = beijingDate(); const target = date || today; const seq = await db.prepare('SELECT archived_through AS archivedThrough FROM daily_sequences WHERE order_date=?').bind(target).first(); const archivedThrough = Number(seq?.archivedThrough) || 0; const cutoff = !includeArchived && target === today ? archivedThrough : 0; const orders = await db.prepare('SELECT order_no AS orderNo, sequence_no AS sequenceNo, meal_period AS mealPeriod, package_name AS packageName, price, main_meat AS mainMeat, side_meat AS sideMeat, name, phone FROM orders WHERE order_date=? AND sequence_no>? ORDER BY sequence_no').bind(target, cutoff).all(); const stats = await db.prepare('SELECT o.meal_period AS mealPeriod, i.dish_group AS dishGroup, i.dish_name AS dishName, SUM(i.quantity) AS quantity FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.order_date=? AND o.sequence_no>? GROUP BY o.meal_period, i.dish_group, i.dish_name ORDER BY i.dish_group, i.dish_name').bind(target, cutoff).all(); const statsByMealPeriod = { lunch: [], dinner: [] }; (stats.results || []).forEach((row) => { const item = { group: row.dishGroup, dishName: row.dishName, quantity: Number(row.quantity) || 0 }; (String(row.mealPeriod).toLowerCase() === 'dinner' || row.mealPeriod === '晚餐' ? statsByMealPeriod.dinner : statsByMealPeriod.lunch).push(item); }); return { date: target, orders: orders.results || [], stats: [...statsByMealPeriod.lunch, ...statsByMealPeriod.dinner], statsByMealPeriod, archiveSequence: archivedThrough, historyRetentionDays: 7 }; }
export async function archiveD1Today(db) { const date = beijingDate(); await ensureD1(db); const current = await db.prepare('SELECT COALESCE(MAX(sequence_no),0) AS maxSequence FROM orders WHERE order_date=?').bind(date).first(); const sequence = Number(current?.maxSequence) || 0; const old = await db.prepare('SELECT archived_through AS archivedThrough FROM daily_sequences WHERE order_date=?').bind(date).first(); const previous = Number(old?.archivedThrough) || 0; if (!sequence || sequence <= previous) return { archivedThrough: previous, archivedOrders: 0 }; await db.prepare('INSERT INTO daily_sequences (order_date, next_sequence, archived_through) VALUES (?, ?, ?) ON CONFLICT(order_date) DO UPDATE SET archived_through=excluded.archived_through').bind(date, sequence + 1, sequence).run(); const count = await db.prepare('SELECT COUNT(*) AS count FROM orders WHERE order_date=? AND sequence_no>? AND sequence_no<=?').bind(date, previous, sequence).first(); return { archivedThrough: sequence, archivedOrders: Number(count?.count) || 0 }; }
