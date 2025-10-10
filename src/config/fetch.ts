import { tdxTokenManager } from "../service/TdxTokenManger";

/**
 * 包裝 fetch：自動加上 Bearer token，401 時強制刷新後重試一次
 */
export async function tdxFetch(
  url: string,
  init?: RequestInit,
  _retried = false
) {
  const token = await tdxTokenManager.getToken();
  const headers = new Headers(init?.headers || {});
  if (!headers.has("Authorization"))
    headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status === 401 && !_retried) {
    await tdxTokenManager.refreshToken(true);
    return tdxFetch(url, init, true);
  }

  return res;
}
