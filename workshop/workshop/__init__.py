"""Workshop — local MCP server. See docs/technical-spec-workshop.md."""
from __future__ import annotations

import subprocess
from datetime import datetime, timezone


__version__ = "0.1.0"


def _read_git_sha() -> str:
    # Cached once at import so /health doesn't fork git on every request.
    # `git rev-parse` walks up from CWD, so this works whether Workshop is
    # started from workshop/ (desktop dev) or C:\workshop-repo\workshop\
    # (Surface, sparse checkout — .git still lives at C:\workshop-repo\).
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=2,
        )
        return out.stdout.strip()[:7] or "unknown"
    except Exception:
        return "unknown"


GIT_SHA: str = _read_git_sha()
START_TIME: datetime = datetime.now(timezone.utc)


def uptime_seconds() -> int:
    delta = datetime.now(timezone.utc) - START_TIME
    return int(delta.total_seconds())
