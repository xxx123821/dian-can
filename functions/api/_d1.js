const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const bool = (value) => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || !['0', 'false', 'no', 'off', '否', '停用', '下架'].includes(String(value ?? '').trim().toLowerCase());

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS packages (id INTEGER PRIMARY KEY AUTOINCREMENT, meal_period TEXT NOT NULL DEFAULT '全部', package_key TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, main_count INTEGER NOT NULL DEFAULT 0, side_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1, UNIQUE(package_key, meal_period));
CREATE TABLE IF NOT EXISTS dishes (id INTEGER PRIMARY KEY AUTOINCREMENT, meal_period TEXT NOT NULL DEFAULT '全部', dish_key TEXT NOT NULL, name TEXT NOT NULL, dish_group TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1, UNIQUE(dish_key, meal_period));
CREATE TABLE IF NOT EXISTS single_types (id INTEGER PRIMARY KEY AUTOINCREMENT, meal_period TEXT NOT NULL DEFAULT '全部', single_key TEXT NOT NULL, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1, UNIQUE(single_key, meal_period));
CREATE TABLE IF NOT EXISTS single_dishes (id INTEGER PRIMARY KEY AUTOINCREMENT, meal_period TEXT NOT NULL DEFAULT '全部', single_key TEXT NOT NULL, dish_key TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, published INTEGER NOT NULL DEFAULT 1, UNIQUE(single_key, meal_period, dish_key));
CREATE TABLE IF NOT EXISTS daily_sequences (order_date TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL DEFAULT 1, archived_through INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_date TEXT NOT NULL, sequence_no INTEGER NOT NULL, order_no TEXT NOT NULL UNIQUE, meal_period TEXT NOT NULL, package_name TEXT NOT NULL, price REAL NOT NULL, main_meat TEXT NOT NULL DEFAULT '', side_meat TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, phone TEXT NOT NULL, submitted_at TEXT NOT NULL, UNIQUE(order_date, sequence_no));
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, order_date TEXT NOT NULL, sequence_no INTEGER NOT NULL, meal_period TEXT NOT NULL, dish_group TEXT NOT NULL, dish_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, package_name TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', FOREIGN KEY(order_id) REFERENCES orders(id));
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date, sequence_no);
CREATE INDEX IF NOT EXISTS idx_items_date ON order_items(order_date, meal_period, dish_name);
`;
let schemaPromise;
export function d1Enabled(env) { return Boolean(env?.DB && typeof env.DB.prepare === 'function'); }
export async function ensureD1(db) {
  if (!schemaPromise) schemaPromise = (async () => {
    await db.exec(SCHEMA);
    // Existing D1 databases created before the single-item feature need these
    // columns; duplicate-column errors simply mean the migration is complete.
    for (const statement of [
      "ALTER TABLE orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'package'",
      "ALTER TABLE orders ADD COLUMN single_key TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE orders ADD COLUMN single_dishes TEXT NOT NULL DEFAULT ''"
    ]) { try { await db.exec(statement); } catch (_) {} }
  })();
  await schemaPromise;
}
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
  const [packages, dishes, singleTypes, singleDishes, settings] = await Promise.all([
    db.prepare('SELECT id, meal_period AS mealPeriod, package_key AS packageKey, name, price, main_count AS mainCount, side_count AS sideCount, enabled, published FROM packages ORDER BY package_key, id').all(),
    db.prepare('SELECT id, meal_period AS mealPeriod, dish_key AS dishKey, name, dish_group AS dishGroup, sort, enabled, published FROM dishes ORDER BY sort, id').all(),
    db.prepare('SELECT id, meal_period AS mealPeriod, single_key AS singleKey, name, price, enabled, published FROM single_types ORDER BY single_key, id').all(),
    db.prepare('SELECT id, meal_period AS mealPeriod, single_key AS singleKey, dish_key AS dishKey, name, sort, enabled, published FROM single_dishes ORDER BY sort, id').all(),
    db.prepare('SELECT key, value, enabled, published FROM settings').all()
  ]);
  return { packages: packages.results || [], dishes: dishes.results || [], singleTypes: singleTypes.results || [], singleDishes: singleDishes.results || [], settings: settings.results || [] };
}

export function adminMenu(config) {
  const settings = {}; (config.settings || []).forEach((row) => { settings[row.key] = { id: '', key: row.key, value: clean(row.value), enabled: bool(row.enabled), published: bool(row.published) }; });
  const singleDishes = config.singleDishes || [];
  const singles = (config.singleTypes || []).map((row) => ({ id: String(row.id), type: 'single', mealPeriod: row.mealPeriod || '全部', key: row.singleKey, name: row.name, price: Number(row.price) || 0, enabled: bool(row.enabled), published: bool(row.published), dishes: singleDishes.filter((dish) => dish.singleKey === row.singleKey && (dish.mealPeriod || '全部') === (row.mealPeriod || '全部')).map((dish) => ({ id: String(dish.id), key: dish.dishKey, name: dish.name, sort: Number(dish.sort) || 0, enabled: bool(dish.enabled), published: bool(dish.published) })) }));
  return {
    packages: (config.packages || []).map((row) => ({ id: String(row.id), type: 'package', mealPeriod: row.mealPeriod || '全部', key: row.packageKey, name: row.name, price: Number(row.price) || 0, mainCount: Number(row.mainCount) || 0, sideCount: Number(row.sideCount) || 0, enabled: bool(row.enabled), published: bool(row.published) })),
    dishes: (config.dishes || []).map((row) => ({ id: String(row.id), type: 'dish', mealPeriod: row.mealPeriod || '全部', key: row.dishKey, name: row.name, group: row.dishGroup, sort: Number(row.sort) || 0, enabled: bool(row.enabled), published: bool(row.published) })),
    singles,
    settings
  };
}

export function publicMenu(config) {
  const mealMenus = { lunch: { packages: {}, singles: [], dishes: { mainMeat: [], sideMeat: [] } }, dinner: { packages: {}, singles: [], dishes: { mainMeat: [], sideMeat: [] } } };
  const settings = {}; (config.settings || []).forEach((row) => { if (row.key) settings[row.key] = clean(row.value); });
  (config.packages || []).filter((row) => bool(row.enabled) && bool(row.published)).forEach((row) => targets(row.mealPeriod).forEach((meal) => { mealMenus[meal].packages[row.packageKey] = { name: clean(row.name, 60), price: Number(row.price) || 0, mainCount: Math.max(0, Number(row.mainCount) || 0), sideCount: Math.max(0, Number(row.sideCount) || 0) }; }));
  (config.dishes || []).filter((row) => bool(row.enabled) && bool(row.published) && clean(row.name)).forEach((row) => targets(row.mealPeriod).forEach((meal) => { const group = clean(row.dishGroup, 30); const target = /副荤|半荤|side/i.test(group) ? mealMenus[meal].dishes.sideMeat : /主荤|主肉|main/i.test(group) ? mealMenus[meal].dishes.mainMeat : null; if (target && !target.includes(row.name)) target.push(row.name); }));
  (config.singleTypes || []).filter((row) => bool(row.enabled) && bool(row.published) && clean(row.name)).forEach((row) => {
    const dishes = (config.singleDishes || []).filter((dish) => dish.singleKey === row.singleKey && (dish.mealPeriod || '全部') === (row.mealPeriod || '全部') && bool(dish.enabled) && bool(dish.published) && clean(dish.name)).sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0) || String(a.name).localeCompare(String(b.name))).map((dish) => clean(dish.name, 100));
    targets(row.mealPeriod).forEach((meal) => mealMenus[meal].singles.push({ key: clean(row.singleKey, 80), name: clean(row.name, 80), price: Number(row.price) || 0, dishes }));
  });
  const fallback = mealMenus.lunch;
  const result = { packages: fallback.packages, singles: fallback.singles, dishes: fallback.dishes, mealMenus, mealSchedule: { lunch: { label: '午餐', start: settings.lunchStart || '00:00', end: settings.lunchEnd || '23:59' }, dinner: { label: '晚餐', start: settings.dinnerStart || '00:00', end: settings.dinnerEnd || '23:59' } }, contactName: settings.contactName || '', contactPhone: settings.contactPhone || '', orderingNotice: settings.orderingNotice || '', orderDeadline: settings.orderDeadline || null };
  const warnings = []; if (!Object.keys(mealMenus.lunch.packages).length && !Object.keys(mealMenus.dinner.packages).length && !mealMenus.lunch.singles.length && !mealMenus.dinner.singles.length) warnings.push('菜单表中没有启用的套餐或单品'); if ((!fallback.dishes.mainMeat.length || !fallback.dishes.sideMeat.length) && (!mealMenus.dinner.dishes.mainMeat.length || !mealMenus.dinner.dishes.sideMeat.length) && !mealMenus.lunch.singles.length && !mealMenus.dinner.singles.length) warnings.push('菜单表中没有启用的菜品'); if (warnings.length) result.menuWarning = warnings.join('；'); return result;
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
  for (const item of (payload.singles || [])) {
    if (!clean(item.name, 100) || !clean(item.key, 80)) continue;
    const typeValues = [clean(item.mealPeriod) || '全部', clean(item.key, 80), clean(item.name, 100), Number(item.price) || 0, writeValue(Boolean(item.enabled)), writeValue(Boolean(item.published))];
    statements.push(item.id && /^\d+$/.test(String(item.id)) ? db.prepare('UPDATE single_types SET meal_period=?, single_key=?, name=?, price=?, enabled=?, published=? WHERE id=?').bind(...typeValues, Number(item.id)) : db.prepare('INSERT INTO single_types (meal_period, single_key, name, price, enabled, published) VALUES (?,?,?,?,?,?)').bind(...typeValues));
    for (const dish of (item.dishes || [])) {
      if (!clean(dish.name, 100) || !clean(dish.key, 80)) continue;
      const dishValues = [clean(item.mealPeriod) || '全部', clean(item.key, 80), clean(dish.key, 80), clean(dish.name, 100), Number(dish.sort) || 0, writeValue(Boolean(dish.enabled)), writeValue(Boolean(dish.published))];
      statements.push(dish.id && /^\d+$/.test(String(dish.id)) ? db.prepare('UPDATE single_dishes SET meal_period=?, single_key=?, dish_key=?, name=?, sort=?, enabled=?, published=? WHERE id=?').bind(...dishValues, Number(dish.id)) : db.prepare('INSERT INTO single_dishes (meal_period, single_key, dish_key, name, sort, enabled, published) VALUES (?,?,?,?,?,?,?)').bind(...dishValues));
    }
  }
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
  for (const key of ['contactName', 'contactPhone', 'lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd']) statements.push(db.prepare('INSERT INTO settings (key, value, enabled, published) VALUES (?, ?, 1, 1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, enabled=1, published=1').bind(key, clean(settings[key], 500)));
  await batch(db, statements); return adminMenu(await readD1Config(db));
}
export async function saveD1Settings(db, settings) { return saveD1Menu(db, { packages: [], dishes: [], settings }); }

function clockMinutes(value) { const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/); if (!match) return NaN; return Number(match[1]) * 60 + Number(match[2]); }
export function d1Schedule(config) { const settings = {}; (config.settings || []).forEach((row) => { settings[row.key] = clean(row.value); }); return { lunch: { label: '午餐', start: settings.lunchStart || '00:00', end: settings.lunchEnd || '23:59' }, dinner: { label: '晚餐', start: settings.dinnerStart || '00:00', end: settings.dinnerEnd || '23:59' } }; }
export function assertD1MealOpen(schedule, period, minutes) { const item = schedule[period]; const start = clockMinutes(item?.start); const end = clockMinutes(item?.end); if (!item || !Number.isFinite(start) || !Number.isFinite(end) || minutes < start || minutes >= end) throw Object.assign(new Error(`${item?.label || period}当前未开放，无法提交`), { status: 400 }); }
export function validateD1Order(input, config) {
  const menu = publicMenu(config).mealMenus?.[input.mealPeriod];
  if (input.orderType === 'single') {
    const single = (menu?.singles || []).find((item) => item.key === input.singleKey || item.name === input.packageName);
    if (!single) throw Object.assign(new Error('单品已更新，请刷新页面后重新点餐'), { status: 400 });
    input.packageName = single.name; input.singleKey = single.key; input.singleDishes = single.dishes.join('、'); input.mainMeat = ''; input.sideMeat = ''; input.price = single.price; return;
  }
  const pkg = menu?.packages?.[input.packageName] || Object.values(menu?.packages || {}).find((item) => item.name === input.packageName);
  if (!pkg) throw Object.assign(new Error('套餐已更新，请刷新页面后重新点餐'), { status: 400 });
  const main = input.mainMeat.split('、').filter(Boolean); const side = input.sideMeat.split('、').filter(Boolean);
  if (main.length !== pkg.mainCount || side.length !== pkg.sideCount || main.some((name) => !menu.dishes.mainMeat.includes(name)) || side.some((name) => !menu.dishes.sideMeat.includes(name))) throw Object.assign(new Error('套餐或菜品已更新，请刷新页面后重新点餐'), { status: 400 });
  input.price = pkg.price; input.orderType = 'package'; input.singleKey = ''; input.singleDishes = '';
}

export async function nextD1Sequence(db, date) { const row = await db.prepare('INSERT INTO daily_sequences (order_date, next_sequence) VALUES (?, 2) ON CONFLICT(order_date) DO UPDATE SET next_sequence = daily_sequences.next_sequence + 1 RETURNING next_sequence - 1 AS sequenceNo').bind(date).first(); const sequence = Number(row?.sequenceNo); if (!Number.isFinite(sequence) || sequence < 1) throw new Error('无法生成当天取餐号'); return sequence; }
export async function peekD1Sequence(db, date) { const row = await db.prepare('SELECT next_sequence FROM daily_sequences WHERE order_date=?').bind(date).first(); return Math.max(1, Number(row?.next_sequence) || 1); }
export async function insertD1Order(db, input, date, sequenceNo) { const orderNo = `D${date.replace(/-/g, '').slice(2)}-${String(sequenceNo).padStart(4, '0')}`; const submittedAt = beijingIso(); const order = await db.prepare('INSERT INTO orders (order_date, sequence_no, order_no, order_type, single_key, single_dishes, meal_period, package_name, price, main_meat, side_meat, name, phone, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(date, sequenceNo, orderNo, input.orderType || 'package', input.singleKey || '', input.singleDishes || '', input.mealPeriod, input.packageName, input.price, input.mainMeat, input.sideMeat, input.name, input.phone, submittedAt).run(); const orderId = order.meta?.last_row_id; const rows = []; const add = (value, group) => String(value || '').split('、').map((name) => name.trim()).filter(Boolean).forEach((dishName) => rows.push(db.prepare('INSERT INTO order_items (order_id, order_date, sequence_no, meal_period, dish_group, dish_name, quantity, package_name, name, phone) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(orderId, date, sequenceNo, input.mealPeriod, group, dishName, 1, input.packageName, input.name, input.phone))); if (input.orderType === 'single') add(input.singleDishes, '单品'); else { add(input.mainMeat, '主荤'); add(input.sideMeat, '副荤'); } if (rows.length) await db.batch(rows); return { orderNo, orderDate: date, sequenceNo, mealPeriod: input.mealPeriod }; }

export async function readD1Live(db, date, includeArchived = false) { await ensureD1(db); const today = beijingDate(); const target = date || today; const seq = await db.prepare('SELECT archived_through AS archivedThrough FROM daily_sequences WHERE order_date=?').bind(target).first(); const archivedThrough = Number(seq?.archivedThrough) || 0; const cutoff = !includeArchived && target === today ? archivedThrough : 0; const orders = await db.prepare('SELECT order_no AS orderNo, sequence_no AS sequenceNo, order_type AS orderType, single_dishes AS singleDishes, meal_period AS mealPeriod, package_name AS packageName, price, main_meat AS mainMeat, side_meat AS sideMeat, name, phone FROM orders WHERE order_date=? AND sequence_no>? ORDER BY sequence_no').bind(target, cutoff).all(); const stats = await db.prepare('SELECT o.meal_period AS mealPeriod, i.dish_group AS dishGroup, i.dish_name AS dishName, SUM(i.quantity) AS quantity FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.order_date=? AND o.sequence_no>? GROUP BY o.meal_period, i.dish_group, i.dish_name ORDER BY i.dish_group, i.dish_name').bind(target, cutoff).all(); const statsByMealPeriod = { lunch: [], dinner: [] }; (stats.results || []).forEach((row) => { const item = { group: row.dishGroup, dishName: row.dishName, quantity: Number(row.quantity) || 0 }; (String(row.mealPeriod).toLowerCase() === 'dinner' || row.mealPeriod === '晚餐' ? statsByMealPeriod.dinner : statsByMealPeriod.lunch).push(item); }); return { date: target, orders: orders.results || [], stats: [...statsByMealPeriod.lunch, ...statsByMealPeriod.dinner], statsByMealPeriod, archiveSequence: archivedThrough, historyRetentionDays: 7 }; }
export async function archiveD1Today(db) { const date = beijingDate(); await ensureD1(db); const current = await db.prepare('SELECT COALESCE(MAX(sequence_no),0) AS maxSequence FROM orders WHERE order_date=?').bind(date).first(); const sequence = Number(current?.maxSequence) || 0; const old = await db.prepare('SELECT archived_through AS archivedThrough FROM daily_sequences WHERE order_date=?').bind(date).first(); const previous = Number(old?.archivedThrough) || 0; if (!sequence || sequence <= previous) return { archivedThrough: previous, archivedOrders: 0 }; await db.prepare('INSERT INTO daily_sequences (order_date, next_sequence, archived_through) VALUES (?, ?, ?) ON CONFLICT(order_date) DO UPDATE SET archived_through=excluded.archived_through').bind(date, sequence + 1, sequence).run(); const count = await db.prepare('SELECT COUNT(*) AS count FROM orders WHERE order_date=? AND sequence_no>? AND sequence_no<=?').bind(date, previous, sequence).first(); return { archivedThrough: sequence, archivedOrders: Number(count?.count) || 0 }; }
