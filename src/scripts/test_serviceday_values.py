import os
import sys
import json
import urllib.request
import urllib.parse

def get_tdx_token(client_id, client_secret):
    url = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret
    }).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))["access_token"]

def main():
    client_id = os.environ.get("TDX_CLIENT_ID")
    client_secret = os.environ.get("TDX_CLIENT_SECRET")
    token = get_tdx_token(client_id, client_secret)

    url = "https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City/Taipei?%24top=10&%24format=JSON"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.loads(res.read().decode("utf-8"))

    print(f"=== 檢查 Taipei Schedule API ServiceDay 原始形態與型別 (共 {len(data)} 筆) ===\n")
    for r in data[:5]:
        route_name = r.get("RouteName", {}).get("Zh_tw")
        timetables = r.get("Timetables") or r.get("TimeTables") or []
        print(f"📍 路線: {route_name} | Timetables: {len(timetables)} 筆")
        if timetables:
            sample_tt = timetables[0]
            sd = sample_tt.get("ServiceDay", {})
            print("   - ServiceDay 原始 JSON 內容:", json.dumps(sd, ensure_ascii=False))
            print("   - 型別細節:")
            for k, v in sd.items():
                print(f"      {k}: {repr(v)} (type: {type(v).__name__})")
        print()

if __name__ == "__main__":
    main()
