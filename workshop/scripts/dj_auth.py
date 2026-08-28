"""Convert copied browser headers into a reusable ytmusicapi credential file.

Also the re-auth path: recopy headers into data/dj/headers.txt, run again.
Lives in scripts/ so it deploys; reads and writes only inside gitignored data/.
"""
from pathlib import Path
import ytmusicapi

ROOT = Path(__file__).resolve().parent.parent
DJ_DATA = ROOT / "data" / "dj"
RAW = DJ_DATA / "headers.txt"
OUT = DJ_DATA / "browser.json"


def main() -> None:
    if not RAW.exists():
        raise SystemExit(f"No headers file at {RAW}. Paste request headers there first.")
    raw = RAW.read_text(encoding="utf-8").strip()
    if "cookie" not in raw.lower():
        raise SystemExit("No Cookie header found. Re-copy — you may have grabbed a GET.")
    ytmusicapi.setup(filepath=str(OUT), headers_raw=raw)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()