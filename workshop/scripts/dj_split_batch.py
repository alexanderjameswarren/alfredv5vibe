"""Split takeout batch files into halves for bisecting a server-side failure.

DIAGNOSTIC ONLY. This does not touch the import path and produces no new rows -
every output row is copied verbatim from an existing batch file, so a slice
carries exactly the same match_key derivation as the whole.

Batches 30 and 32 fail with a 500 on the DRY RUN, reproducibly, while 31, 33 and
34 pass. Nothing in the data shape, the derivation, or a full local replay of the
tool logic distinguishes them, so the question is whether the failure tracks the
SIZE of a request or the CONTENT of specific rows.

    both halves pass  -> size or time limit; the fix is smaller batches
    one half fails    -> the offending rows are in that half; halve again

WHY THE FULL BATCH IS EMITTED TOO, AS A CONTROL. "Both halves passed" is also
what a transient fault looks like once it has stopped happening. Without the
unchanged 500-row file failing in the SAME session, the split proves nothing -
it would be a check that cannot fail (spec 11.1). The control must still fail.

Usage, from workshop/:
    .\\.venv\\Scripts\\python.exe scripts\\dj_split_batch.py 30 32
    .\\.venv\\Scripts\\python.exe scripts\\dj_split_batch.py 30 --parts 4
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "dj" / "takeout-batches"
OUT = ROOT / "data" / "dj" / "takeout-probe"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batches", type=int, nargs="+", help="batch numbers to split")
    ap.add_argument("--parts", type=int, default=2, help="slices per batch (default 2)")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for old in args.out.glob("batch_*.json"):
        old.unlink()

    n = 0
    manifest: list[str] = []
    for b in args.batches:
        src = SRC / f"batch_{b:03d}.json"
        body = json.loads(src.read_text(encoding="utf-8"))
        plays = body["plays"]

        # Control first: the unchanged batch, which must STILL FAIL in this run.
        n += 1
        (args.out / f"batch_{n:03d}.json").write_text(
            json.dumps(body, ensure_ascii=False), encoding="utf-8")
        manifest.append(f"batch_{n:03d}.json = batch {b} UNCHANGED, {len(plays)} rows "
                        f"-- CONTROL, expected to FAIL")

        size = (len(plays) + args.parts - 1) // args.parts
        for i in range(args.parts):
            slice_ = plays[i * size:(i + 1) * size]
            if not slice_:
                continue
            n += 1
            (args.out / f"batch_{n:03d}.json").write_text(
                json.dumps({**body, "plays": slice_}, ensure_ascii=False),
                encoding="utf-8")
            manifest.append(
                f"batch_{n:03d}.json = batch {b} rows {i * size + 1}-{i * size + len(slice_)}"
                f", {len(slice_)} rows  ({slice_[0]['played_on']} .. {slice_[-1]['played_on']})")

    (args.out / "MANIFEST.txt").write_text("\n".join(manifest) + "\n", encoding="utf-8")
    print(f"wrote {n} file(s) to {args.out}\n")
    for line in manifest:
        print("  " + line)


if __name__ == "__main__":
    main()
