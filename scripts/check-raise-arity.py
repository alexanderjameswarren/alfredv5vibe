"""Check RAISE placeholder/argument arity in PL/pgSQL migrations.

PostgreSQL rejects a mismatch at COMPILE time with 'too many parameters
specified for RAISE' — so a wrong count kills the whole migration block, and it
is invisible until the file is run against a live database. That is a mechanical
error class and deserves a mechanical check.

Counting rule: in a RAISE format string `%%` is an ESCAPED literal percent
(consuming no argument) and a bare `%` is a placeholder.
"""
import io
import re
import sys


def split_top_level(s):
    """Split on commas that are not inside quotes or parentheses."""
    out, buf, depth, i, in_str = [], [], 0, 0, False
    while i < len(s):
        c = s[i]
        if in_str:
            if c == "'":
                # '' is an escaped quote inside a string literal
                if i + 1 < len(s) and s[i + 1] == "'":
                    buf.append("''")
                    i += 2
                    continue
                in_str = False
            buf.append(c)
        elif c == "'":
            in_str = True
            buf.append(c)
        elif c in "([":
            depth += 1
            buf.append(c)
        elif c in ")]":
            depth -= 1
            buf.append(c)
        elif c == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(c)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf).strip())
    return out


def count_placeholders(fmt):
    n, i = 0, 0
    while i < len(fmt):
        if fmt[i] == "%":
            if i + 1 < len(fmt) and fmt[i + 1] == "%":
                i += 2          # escaped literal percent
                continue
            n += 1
        i += 1
    return n


RAISE = re.compile(r"\braise\s+(notice|exception|warning)\b", re.I)

failures = []
checked = 0

for path in sys.argv[1:]:
    src = io.open(path, encoding="utf-8").read()
    # Strip line comments so a `%` in prose cannot be mistaken for a placeholder.
    body = "\n".join(
        line.split("--", 1)[0] if "--" in line and "'" not in line.split("--", 1)[0]
        else line
        for line in src.split("\n")
    )
    for m in RAISE.finditer(body):
        # ⚠️ THE TERMINATOR MUST BE FOUND OUTSIDE STRING LITERALS. A naive
        # find(";") stopped inside 'has zero touch days; "never" and ...' and
        # reported a real, working RAISE in 016 as a mismatch — a checker whose
        # false positives look exactly like its true ones is worse than none.
        end, i, in_str = -1, m.end(), False
        while i < len(body):
            c = body[i]
            if in_str:
                if c == "'":
                    if i + 1 < len(body) and body[i + 1] == "'":
                        i += 2
                        continue
                    in_str = False
            elif c == "'":
                in_str = True
            elif c == ";":
                end = i
                break
            i += 1
        if end == -1:
            continue
        stmt = body[m.end():end]
        parts = split_top_level(stmt)
        if not parts:
            continue
        # The format is the first top-level part: adjacent 'a' 'b' literals
        # concatenated by juxtaposition, which is how these files wrap long text.
        fmt_part = parts[0]
        lits = re.findall(r"'((?:[^']|'')*)'", fmt_part, re.S)
        if not lits:
            continue
        fmt = "".join(lits)
        want = count_placeholders(fmt)
        got = len(parts) - 1
        checked += 1
        if want != got:
            line_no = body[:m.start()].count("\n") + 1
            failures.append(
                f"{path}:{line_no}  {want} placeholder(s), {got} argument(s)\n"
                f"    {fmt[:110]!r}"
            )

print(f"checked {checked} RAISE statement(s)")
for f in failures:
    print("MISMATCH " + f)
sys.exit(1 if failures else 0)
