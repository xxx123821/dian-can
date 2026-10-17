/** SeaTable Base API helper: exchange an API Token for a Base Token, then use the Base API. */
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

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
  let origin = origins[0];
  for (const candidate of origins) {
    try {
      const response = await fetch(`${candidate}/api/v2.1/dtable/app-access-token/`, {
        // SeaTable's "Get Base-Token with API-Token" endpoint requires Bearer auth.
        headers: { Authorization: `Bearer ${apiToken}` },
        cache: 'no-store'
      });
      tokenResponse = response;
      origin = candidate;
      break;
    } catch (_) {
      // A stale SEATABLE_API_ORIGIN should not prevent the built-in official
      // endpoint from being tried next.
    }
  }
  // If both auth requests were temporarily unreachable, still try the Base
  // API with the configured token; base-scoped tokens do not need exchange.
  if (!tokenResponse) tokenResponse = { ok: false, status: 0, text: async () => '' };
  const tokenText = await tokenResponse.text();
  let tokenData = {};
  try { tokenData = tokenText ? JSON.parse(tokenText) : {}; } catch (_) { }
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
  const endpoint = method === 'GET' ? `${collectionEndpoint}?${query}` : collectionEndpoint;
  const requestBody = method === 'POST'
    ? { table_name: table, rows: [row] }
    : method === 'PUT'
      ? { table_name: table, updates: [{ row_id: rowId, row }] }
      : { table_name: table, row };
  let response;
  const send = (url, body, requestMethod = method) => fetch(url, {
      method: requestMethod,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: requestMethod === 'GET' ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
  try {
    response = await send(endpoint, requestBody);
    // Older SeaTable deployments expose the row-id URL form. Keep a narrow
    // compatibility retry for those installations while preferring the
    // current API-gateway format above.
    if (!response.ok && response.status === 405 && method === 'PUT' && rowId) {
      const legacyEndpoint = `${collectionEndpoint}${encodeURIComponent(rowId)}/?table_name=${encodeURIComponent(table)}`;
      response = await send(legacyEndpoint, { table_name: table, row });
    }
  } catch (_) { throw new Error('已连接 SeaTable 鉴权服务，但无法连接 Base 数据接口'); }
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
