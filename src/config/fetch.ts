import { tdxTokenManager } from "../service/TdxTokenManger";

/**
 * 包裝 fetch：自動加上 Bearer token。401 時強制刷新 token 後重試一次；
 * 429（配額/速率限制）時退避 1.5s 後重試一次。
 *
 * 429 退避集中於此，所有呼叫端（路線規劃、即時資訊、controllers、匯入腳本）
 * 都能在 TDX 短時間連發 4–6 次觸發的速率限制下存活，而不是各自把 429 當成
 * 空資料靜默吞掉。
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

  if (res.status === 429 && !_retried) {
    await new Promise((r) => setTimeout(r, 1500));
    return tdxFetch(url, init, true);
  }

  return res;
}
