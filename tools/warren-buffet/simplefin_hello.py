"""
Warren Buffet - SimpleFIN hello world.

First run (claims your setup token, which can only be claimed ONCE):
    python simplefin_hello.py <SETUP_TOKEN>
    -> prints an access URL. Save it in a .env file as SIMPLEFIN_ACCESS_URL=...
       Treat it like a password: anyone with it can read all your accounts.

Later runs:
    set SIMPLEFIN_ACCESS_URL in your environment, then:
    python simplefin_hello.py

Writes the full raw response to simplefin_raw.json (keep this local)
and prints a summary to paste back to Claude.
"""
import base64, json, os, sys, time
from urllib.parse import urlparse
import requests
from dotenv import load_dotenv
load_dotenv()

def claim(setup_token: str) -> str:
    claim_url = base64.b64decode(setup_token.strip()).decode()
    r = requests.post(claim_url, timeout=30)
    r.raise_for_status()
    return r.text.strip()

def fetch(access_url: str, days: int = 90) -> dict:
    u = urlparse(access_url)
    base = f"{u.scheme}://{u.hostname}{u.path}"
    params = {"start-date": int(time.time()) - days * 86400, "pending": 1}
    r = requests.get(f"{base}/accounts", params=params,
                     auth=(u.username, u.password), timeout=60)
    r.raise_for_status()
    return r.json()

def summarize(data: dict) -> None:
    print("ERRORS:", data.get("errors") or "none")
    print("TOP-LEVEL KEYS:", sorted(data.keys()))
    for a in data.get("accounts", []):
        txns = a.get("transactions", [])
        holdings = a.get("holdings", [])
        org = a.get("org", {}).get("name") or a.get("org", {}).get("domain")
        print("\n" + "=" * 60)
        print(f"{org} | {a.get('name')} | {a.get('currency')}")
        print(f"  balance={a.get('balance')}  available={a.get('available-balance')}")
        print(f"  account keys: {sorted(k for k in a.keys() if k != 'transactions')}")
        print(f"  transactions: {len(txns)}  holdings: {len(holdings)}")
        if txns:
            dates = sorted(t.get("posted") or t.get("transacted_at") or 0 for t in txns)
            fmt = lambda s: time.strftime("%Y-%m-%d", time.localtime(s)) if s else "?"
            print(f"  date range: {fmt(dates[0])} to {fmt(dates[-1])}")
            print(f"  transaction keys: {sorted(txns[0].keys())}")
            for t in txns[:3]:
                print(f"    sample: {t.get('amount')} | {t.get('description')} "
                      f"| pending={t.get('pending')} | extra={t.get('extra')}")
        if holdings:
            print(f"  holding keys: {sorted(holdings[0].keys())}")

if __name__ == "__main__":
    access = os.environ.get("SIMPLEFIN_ACCESS_URL")
    if len(sys.argv) > 1:
        access = claim(sys.argv[1])
        print("ACCESS URL (save this as SIMPLEFIN_ACCESS_URL, do NOT paste it to Claude):")
        print(access, "\n")
    if not access:
        sys.exit("Pass a setup token or set SIMPLEFIN_ACCESS_URL.")
    data = fetch(access)
    with open("simplefin_raw.json", "w") as f:
        json.dump(data, f, indent=2)
    summarize(data)