/** SeaTable Base API helper: exchange an API Token for a Base Token, then use the Base API. */
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
// A single order can touch the menu, order and statistics tables. Reusing the
// short-lived exchanged Base Token avoids an extra authentication round trip
// for every one of those requests while keeping the cache local to this
// Worker isolate (the token itself is never sent to the browser).
const tokenCache = new Map();
const TOKEN_CACHE_MS = 5 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 12000;
const READ_TIMEOUT_MS = 20000;
const WRITE_TIMEOUT_MS = 45000;

async function fetchWithTimeout(url, options = {}, timeoutMs = READ_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function exchangeToken(origin, apiToken) {
  const key = `${origin}|${apiToken}`;
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = (async () => {
    const response = await fetchWithTimeout(`${origin}/api/v2.1/dtable/app-access-token/`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      cache: 'no-store'
    }, TOKEN_TIMEOUT_MS);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { }
    return { ok: response.ok, status: response.status, data, text };
  })();
  tokenCache.set(key, { expiresAt: now + TOKEN_CACHE_MS, promise });
  try { return await promise; } catch (error) { tokenCache.delete(key); throw error; }
}

export async function seaTableRequest(env, tableName, method = 'GET', row = null, rowId = '') {
  const baseUuid = clean(env.SEATABLE_BASE_UUID, 120);
  const apiToken = clean(env.SEATABLE_BASE_TOKEN, 1000);
  const table = clean(tableName, 100);
  if (!baseUuid || !apiToken) throw new Error('服务端尚未配置 SeaTable 表格 UUID 或 API Token');
  if (!table) throw new Error('未配置 SeaTable 表名');
  const configuredOrigin = String(env.SEATABLE_API_ORIGIN || '').trim().replace(/\/$/, '');
  // This deployment uses SeaTable China Cloud. Try the official endpoint
  // first so an old or mistyped optional variable cannot route writes to a
  // different host; a custom origin remains available as a fallback.
  const origins = [...new Set(['https://cloud.seatable.cn', configuredOrigin].filter(Boolean))];

  let tokenResponse;
  let tokenData = {};
  let origin = origins[0];
  for (const candidate of origins) {
    try {
      const exchanged = await exchangeToken(candidate, apiToken);
      tokenResponse = exchanged;
      tokenData = exchanged.data || {};
      origin = candidate;
      break;
    } catch (_) {
      // A stale SEATABLE_API_ORIGIN should not prevent the built-in official
      // endpoint from being tried next.
    }
  }
  // If both auth requests were temporarily unreachable, still try the Base
  // API with the configured token; base-scoped tokens do not need exchange.
  if (!tokenResponse) tokenResponse = { ok: false, status: 0, text: '' };
  // SeaTable installations expose two similar credentials in different places:
  // a base-scoped API token (already usable as Bearer on the Base API), and an
  // account API token (must first be exchanged for a Base Token). Support both.
  let accessToken = tokenResponse.ok ? clean(tokenData.access_token, 2000) : '';
  if (!accessToken) accessToken = apiToken;

  const query = new URLSearchParams({ table_name: table });
  if (method === 'GET') {
    query.set('limit', '1000');
    query.set('convert_keys', 'true');
  }
  // SeaTable's API-gateway uses the collection endpoint for both appending
  // and updating rows. Updates carry row_id inside an `updates` array; a
  // row-id URL (the older Base API form) returns HTTP 405 on cloud.seatable.cn.
  const collectionEndpoint = `${origin}/api-gateway/api/v2/dtables/${encodeURIComponent(baseUuid)}/rows/`;
  const endpoint = `${collectionEndpoint}?${query}`;
  const batch = Array.isArray(row);
  const requestBody = method === 'POST'
    ? { table_name: table, rows: batch ? row : [row] }
    : method === 'PUT'
      ? { table_name: table, updates: batch ? row : [{ row_id: rowId, row }] }
      : { table_name: table, row };
  let response;
  const send = (url, body, requestMethod = method) => fetchWithTimeout(url, {
      method: requestMethod,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: requestMethod === 'GET' ? undefined : JSON.stringify(body),
      cache: 'no-store'
    }, requestMethod === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  const attempts = [];
  try {
    const candidates = [{ url: endpoint, body: requestBody, method }];
    // SeaTable cloud has had two gateway write formats in production. Try the
    // current body first, then the older single-row/row-id forms when the
    // gateway rejects it. Never retry after a successful response.
    if (method === 'POST' && !batch) {
      candidates.push({ url: endpoint, body: { table_name: table, row }, method });
      candidates.push({ url: collectionEndpoint, body: requestBody, method });
    } else if (method === 'PUT' && rowId && !batch) {
      candidates.push({ url: `${collectionEndpoint}${encodeURIComponent(rowId)}/?table_name=${encodeURIComponent(table)}`, body: { table_name: table, row }, method });
      candidates.push({ url: `${collectionEndpoint}${encodeURIComponent(rowId)}/`, body: row, method });
    }
    for (const candidate of candidates) {
      try {
        response = await send(candidate.url, candidate.body, candidate.method);
        if (response.ok || ![400, 404, 405, 422].includes(response.status)) break;
        attempts.push(`${candidate.method} ${candidate.url} -> HTTP ${response.status}`);
      } catch (error) {
        attempts.push(`${candidate.method} ${candidate.url} -> ${clean(error?.message || error, 160)}`);
      }
    }
  } catch (error) {
    throw new Error(`已连接 SeaTable 鉴权服务，但无法连接 Base 数据接口${error?.message ? `：${clean(error.message, 180)}` : ''}`);
  }
  if (!response) throw new Error(`无法连接 SeaTable Base 数据接口${attempts.length ? `（${attempts.join('；')}）` : ''}`);
  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const data = JSON.parse(text);
      detail = clean(data.error || data.error_msg || data.message || data.detail || data.msg || data.error_message, 240);
    } catch (_) { }
    // SeaTable sometimes returns a plain-text validation message or a JSON
    // shape not covered above. Keep the response body (never the token) so
    // the merchant can see which column/value caused a 400.
    if (!detail && text) detail = clean(text.replace(/\s+/g, ' '), 240);
    if (response.status === 401 || response.status === 403) {
      const tokenDetail = !tokenResponse.ok ? clean(tokenData.error || tokenData.error_msg || tokenData.message || tokenData.detail, 160) : '';
      const exchange = !tokenResponse.ok ? `（API Token 换取 Base Token 也返回 HTTP ${tokenResponse.status}${tokenDetail ? `：${tokenDetail}` : ''}）` : '';
      throw new Error(`SeaTable 拒绝访问表“${table}”（HTTP ${response.status}）。请确认此令牌属于该 Base、UUID 正确、令牌仍有效且有读写权限，表名完全匹配${detail ? `：${detail}` : ''}${exchange}`);
    }
    throw new Error(detail ? `SeaTable 请求失败（HTTP ${response.status}）：${detail}` : `SeaTable 请求失败（HTTP ${response.status}）`);
  }
  try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
}
