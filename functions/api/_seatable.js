/** SeaTable Base API helper: exchange an API Token for a Base Token, then use the Base API. */
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

export async function seaTableRequest(env, tableName, method = 'GET', row = null, rowId = '') {
  const baseUuid = clean(env.SEATABLE_BASE_UUID, 120);
  const apiToken = clean(env.SEATABLE_BASE_TOKEN, 1000);
  const table = clean(tableName, 100);
  if (!baseUuid || !apiToken) throw new Error('服务端尚未配置 SeaTable 表格 UUID 或 API Token');
  if (!table) throw new Error('未配置 SeaTable 表名');
  const origin = String(env.SEATABLE_API_ORIGIN || 'https://cloud.seatable.cn').replace(/\/$/, '');

  let tokenResponse;
  try {
    tokenResponse = await fetch(`${origin}/api/v2.1/dtable/app-access-token/`, {
      // SeaTable's "Get Base-Token with API-Token" endpoint requires Bearer auth.
      headers: { Authorization: `Bearer ${apiToken}` },
      cache: 'no-store'
    });
  } catch (_) { throw new Error('无法连接 SeaTable 鉴权接口，请检查 SEATABLE_API_ORIGIN'); }
  const tokenText = await tokenResponse.text();
  let tokenData = {};
  try { tokenData = tokenText ? JSON.parse(tokenText) : {}; } catch (_) { }
  if (!tokenResponse.ok) {
    const detail = clean(tokenData.error || tokenData.error_msg || tokenData.message || tokenData.detail, 240);
    const hint = `SeaTable API Token 换取 Base Token 请求失败（HTTP ${tokenResponse.status}）`;
    throw new Error(detail ? `${hint}：${detail}` : hint);
  }

  const accessToken = clean(tokenData.access_token, 2000);
  if (!accessToken) throw new Error('SeaTable 鉴权成功但未返回 Base Token；请确认填写的是 API Token，而非表单分享链接或普通账号令牌');

  const query = new URLSearchParams({ table_name: table });
  if (method === 'GET') query.set('limit', '1000');
  const rowPath = rowId ? `${encodeURIComponent(rowId)}/` : '';
  const endpoint = `${origin}/api-gateway/api/v2/dtables/${encodeURIComponent(baseUuid)}/rows/${rowPath}?${query}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ table_name: table, row }),
      cache: 'no-store'
    });
  } catch (_) { throw new Error('已连接 SeaTable 鉴权服务，但无法连接 Base 数据接口'); }
  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try { const data = JSON.parse(text); detail = clean(data.error || data.error_msg || data.message || data.detail, 240); } catch (_) { }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`SeaTable 拒绝访问表“${table}”（HTTP ${response.status}）。请确认 Base Token 对该 Base 有读写权限、Base UUID 正确，并且表名完全匹配${detail ? `：${detail}` : ''}`);
    }
    throw new Error(detail ? `SeaTable 请求失败：${detail}` : `SeaTable 请求失败（HTTP ${response.status}）`);
  }
  try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
}
