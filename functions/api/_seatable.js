/** SeaTable Base API helper: exchange the long-lived Base Token for an access token. */
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);

export async function seaTableRequest(env, tableName, method = 'GET', row = null, rowId = '') {
  const baseUuid = clean(env.SEATABLE_BASE_UUID, 120);
  const baseToken = clean(env.SEATABLE_BASE_TOKEN, 1000);
  const table = clean(tableName, 100);
  if (!baseUuid || !baseToken) throw new Error('服务端尚未配置 SeaTable Base UUID 或 Base Token');
  if (!table) throw new Error('未配置 SeaTable 表名');
  const origin = String(env.SEATABLE_API_ORIGIN || 'https://cloud.seatable.cn').replace(/\/$/, '');

  let tokenResponse;
  try {
    tokenResponse = await fetch(`${origin}/api/v2.1/dtable/app-access-token/`, {
      headers: { Authorization: `Token ${baseToken}` },
      cache: 'no-store'
    });
  } catch (_) { throw new Error('无法连接 SeaTable 鉴权接口，请检查 SEATABLE_API_ORIGIN'); }
  const tokenText = await tokenResponse.text();
  let tokenData = {};
  try { tokenData = tokenText ? JSON.parse(tokenText) : {}; } catch (_) { }
  if (!tokenResponse.ok) {
    const detail = clean(tokenData.error || tokenData.message || tokenData.detail, 180);
    const hint = tokenResponse.status === 401 || tokenResponse.status === 403
      ? 'SeaTable Base Token 无效或未授权；请在 SeaTable 重新生成有读写权限的 Base API Token，并更新 Cloudflare 的 SEATABLE_BASE_TOKEN'
      : `SeaTable Token 接口返回 HTTP ${tokenResponse.status}`;
    throw new Error(detail ? `${hint}（${detail}）` : hint);
  }

  const accessToken = clean(tokenData.access_token, 2000);
  const dtableUuid = clean(tokenData.dtable_uuid || baseUuid, 120);
  const dtableServer = String(tokenData.dtable_server || `${origin}/dtable-server/`).replace(/\/$/, '');
  if (!accessToken) throw new Error('SeaTable 鉴权成功但未返回 access_token；请确认填写的是 Base API Token，而非表单分享链接或普通账号令牌');

  const query = new URLSearchParams({ table_name: table });
  if (method === 'GET') query.set('limit', '1000');
  const rowPath = rowId ? `${encodeURIComponent(rowId)}/` : '';
  const endpoint = `${dtableServer}/api/v1/dtables/${encodeURIComponent(dtableUuid)}/rows/${rowPath}?${query}`;
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
    try { const data = JSON.parse(text); detail = clean(data.error || data.message || data.detail, 180); } catch (_) { }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`SeaTable 拒绝访问表“${table}”（HTTP ${response.status}）。请确认 Base Token 对该 Base 有读写权限、Base UUID 正确，并且表名完全匹配${detail ? `：${detail}` : ''}`);
    }
    throw new Error(detail ? `SeaTable 请求失败：${detail}` : `SeaTable 请求失败（HTTP ${response.status}）`);
  }
  try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
}
