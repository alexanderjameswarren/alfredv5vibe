"""Read-only smoke test. Changes nothing, writes nothing."""
import json
from collections import Counter
from pathlib import Path
from ytmusicapi import YTMusic

ROOT = Path(__file__).resolve().parent.parent
yt = YTMusic(str(ROOT / "data" / "dj" / "browser.json"))

print("=== PLAYLISTS ===")
for p in yt.get_library_playlists(limit=50):
    print(f"  {str(p.get('title'))[:40]:42} tracks={p.get('count')}  id={p.get('playlistId')}")

print("\n=== HISTORY ===")
hist = yt.get_history()
print(f"  items returned: {len(hist)}")
for label, n in Counter(h.get("played") for h in hist).items():
    print(f"    {str(label):20} {n} plays")

print("\n=== SAMPLE ITEM ===")
if hist:
    print(json.dumps(hist[0], indent=2)[:1500])