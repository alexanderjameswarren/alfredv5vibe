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

!! THE CONTROL IS A BYTE-FOR-BYTE COPY, AND THE SLICES ARE SERIALISED EXACTLY AS
   dj_takeout_prepare.py SERIALISES THEM. The first version of this script got
   that wrong and invalidated a whole probe run.

   It rebuilt the control with json.dumps(..., ensure_ascii=False), producing a
   file with the same DATA and different BYTES: the real batch files are PURE
   ASCII (non-ASCII is escaped as \\uXXXX by json.dumps's default
   ensure_ascii=True), while the rebuilt files carried raw UTF-8. That matters
   because PowerShell 5.1's Invoke-RestMethod corrupts non-ASCII in a string
   body - so the probe files were corrupted in transit and the real batch files
   never could be. Every result from that run measured the splitter, not the
   batch.

   A control must be a COPY, not a reconstruction. Reconstructing it re-runs the
   serialiser, and the serialiser is part of what is under test.

Usage, from workshop/:
    .\\.venv\\Scripts\\python.exe scripts\\dj_split_batch.py 30 32
    .\\.venv\\Scripts\\python.exe scripts\\dj_split_batch.py 30 --parts 4
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "dj" / "takeout-batches"
OUT = ROOT / "data" / "dj" / "takeout-probe"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("batches", type=int, nargs="+", help="batch numbers to split")
    ap.add_argument("--parts", type=int, default=2, help="slices per batch (default 2)")
    ap.add_argument("--head", type=int, default=0,
                    help="instead of parts, emit ONE slice of the first N rows")
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
        # COPIED, never re-serialised - see the note at the top of this file.
        n += 1
        shutil.copyfile(src, args.out / f"batch_{n:03d}.json")
        manifest.append(f"batch_{n:03d}.json = batch {b} UNCHANGED, {len(plays)} rows "
                        f"-- CONTROL, must reproduce its previous result")

        if args.head:
            slices = [plays[:args.head]]
            size = args.head
        else:
            size = (len(plays) + args.parts - 1) // args.parts
            slices = [plays[i * size:(i + 1) * size] for i in range(args.parts)]
        for i, slice_ in enumerate(slices):
            if not slice_:
                continue
            n += 1
            # Byte-for-byte the same serialisation dj_takeout_prepare.py uses:
            # indent=1 and the DEFAULT ensure_ascii=True, so a slice is ASCII
            # exactly as the batch it came from is.
            (args.out / f"batch_{n:03d}.json").write_text(
                json.dumps({**body, "plays": slice_}, indent=1), encoding="utf-8")
            manifest.append(
                f"batch_{n:03d}.json = batch {b} rows {i * size + 1}-{i * size + len(slice_)}"
                f", {len(slice_)} rows  ({slice_[0]['played_on']} .. {slice_[-1]['played_on']})")

    # Prove it rather than trust it: no byte over 127 may appear in any output
    # that is absent from its source. This is the check the first version needed.
    for f in sorted(args.out.glob("batch_*.json")):
        raw = f.read_bytes()
        hi = sum(1 for b in raw if b > 127)
        if hi:
            raise SystemExit(
                f"ABORT: {f.name} contains {hi} byte(s) > 127. The real batch files "
                f"are pure ASCII; a probe file that is not tests the splitter, not "
                f"the batch.")

    (args.out / "MANIFEST.txt").write_text("\n".join(manifest) + "\n", encoding="utf-8")
    print(f"wrote {n} file(s) to {args.out}\n")
    for line in manifest:
        print("  " + line)


if __name__ == "__main__":
    main()
