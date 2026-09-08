"""Is the YouTube credential still ALIVE — not merely present.

===========================================================================
🛑 WHY `credential_readable` WAS NEVER GOING TO BE ENOUGH
===========================================================================
``dj.credential_state()`` says the file exists and can be read, and its own
docstring says that is not proof YouTube still accepts it. Only a network call
proves that. The distinction is not academic: a cookie expires while the file
sits there perfectly readable, and every DJ read then fails — the daily sync,
the weekly review, the jazz thread and the concert skill all run through that
one file.

===========================================================================
⚠️ A FAILURE MUST NEVER ERASE THE LAST SUCCESS
===========================================================================
"The cookie is dead" is half the information. "The cookie is dead and it last
worked on 12 September" is the whole of it — it says whether this happened an
hour ago or a fortnight ago, which is the difference between a blip and a
fortnight of silently missing plays.

So the state file holds BOTH, independently, and recording a failure leaves the
success timestamp untouched. Every read is defensive: a missing or corrupt state
file returns empty state rather than raising, because an error here would hide
exactly the timestamp it exists to report.

===========================================================================
🛑 SUCCESS IS RECORDED FROM THE SHARED CALL PATH, NOT ONLY FROM THE PROBE
===========================================================================
If only an explicit probe wrote here, `last_success` would mean "the last time
somebody ran the checker" — which says nothing about whether anything works.

Recorded from every successful ytmusicapi call instead, it means what it should:
THE LAST TIME YOUTUBE ACCEPTED THIS CREDENTIAL, from any source. That makes the
AGE a second signal for free: the daily sync calls YouTube every day, so a
success older than about a day means the sync is not running either — a
different fault, revealed by the same number, with no failure recorded anywhere.

⚠️ THROTTLED, because this sits on a hot path. One write per
``_SUCCESS_THROTTLE_SECONDS`` at most; the resolution that matters is hours.

⚠️ AND IT MUST NEVER RAISE. A read-only data directory, a locked file, a full
disk — none of those are reasons for a DJ tool to fail. Bookkeeping that can
break the thing it observes is worse than no bookkeeping.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

_WORKSHOP_ROOT = Path(__file__).resolve().parents[1]
PROBE_STATE_PATH = _WORKSHOP_ROOT / "data" / "dj" / "credential-probe.json"

# At most one success write per five minutes. The question this answers is
# "hours or days?", so finer resolution buys nothing and costs a file write on
# every YouTube call.
_SUCCESS_THROTTLE_SECONDS = 300

# The daily sync calls YouTube once a day. 36 hours allows a late run and a
# clock skew; beyond it, a missing failure is not reassurance — it means
# nothing has called YouTube at all, which is its own fault.
STALE_SUCCESS_SECONDS = 36 * 3600

_last_write_monotonic: float | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def read_state() -> dict[str, Any]:
    """The recorded state. NEVER raises — an unreadable file returns empty.

    ⚠️ This is the function whose failure would hide the timestamp it exists to
    report, so every path returns a dict.
    """
    try:
        raw = PROBE_STATE_PATH.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _write_state(state: dict[str, Any]) -> None:
    """Best effort. Swallows everything — see the module docstring."""
    try:
        PROBE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = PROBE_STATE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(PROBE_STATE_PATH)
    except Exception as e:  # noqa: BLE001 — bookkeeping must never break a tool
        log.debug("credential probe state not written: %s", e)


def record_success(source: str = "call") -> None:
    """YouTube accepted the credential. Throttled; never raises."""
    global _last_write_monotonic
    now = time.monotonic()
    if (_last_write_monotonic is not None
            and now - _last_write_monotonic < _SUCCESS_THROTTLE_SECONDS):
        return
    _last_write_monotonic = now
    state = read_state()
    state["last_success"] = _now_iso()
    state["last_success_source"] = source
    _write_state(state)


def record_failure(kind: str, detail: str, source: str = "call") -> None:
    """YouTube refused, or the call broke. NEVER touches ``last_success``.

    ⚠️ `kind` SEPARATES A DEAD COOKIE FROM A BAD NIGHT, and the distinction is
    the whole point: 'auth_expired' means do the twenty-minute reauth,
    'upstream_error' means try again later. Recording a network blip as a dead
    credential would send Alex through the recovery procedure for nothing, and
    the procedure is rare enough that doing it needlessly teaches the wrong
    lesson about when it is needed.
    """
    state = read_state()
    state["last_failure"] = _now_iso()
    state["last_failure_kind"] = kind
    # Detail is already scrubbed by the caller; truncated here as a second
    # guard, because this file is read by a script that prints it.
    state["last_failure_detail"] = (detail or "")[:400]
    state["last_failure_source"] = source
    _write_state(state)


def classify(detail: str, status: int | None) -> str:
    """auth_expired | upstream_error, from the same signals dj._upstream_error uses."""
    lowered = (detail or "").lower()
    auth_signals = ("unauthorized", "401", "403", "forbidden",
                    "authentication", "cookie", "sapisid", "login")
    if status in (401, 403) or any(s in lowered for s in auth_signals):
        return "auth_expired"
    return "upstream_error"


def summarise(state: dict[str, Any] | None = None) -> dict[str, Any]:
    """The state plus the two things a reader actually needs: AGE and ORDER.

    🛑 AGE, NOT JUST A DATE. "Last confirmed working 6 hours ago" and "last
    confirmed working 9 days ago" read completely differently, and the second is
    a finding even with no failure recorded — nothing has called YouTube.

    🛑 ORDER, because a failure NEWER than the last success is the alarm and a
    failure OLDER than it is history. The same two timestamps mean opposite
    things depending which came last, and a reader comparing them by eye gets it
    wrong at exactly the wrong moment.
    """
    st = read_state() if state is None else state
    now = datetime.now(timezone.utc)

    succ = _parse_iso(st.get("last_success"))
    fail = _parse_iso(st.get("last_failure"))

    succ_age = int((now - succ).total_seconds()) if succ else None
    fail_age = int((now - fail).total_seconds()) if fail else None

    failing = bool(fail and (succ is None or fail > succ))

    return {
        "last_success": st.get("last_success"),
        "last_success_age_seconds": succ_age,
        "last_success_source": st.get("last_success_source"),
        "last_failure": st.get("last_failure"),
        "last_failure_age_seconds": fail_age,
        "last_failure_kind": st.get("last_failure_kind"),
        "last_failure_detail": st.get("last_failure_detail"),
        # The newest event is a failure: something is wrong NOW.
        "failing": failing,
        # ⚠️ STALE IS A SEPARATE FAULT FROM FAILING. No failure recorded and no
        # success for a day and a half means nothing has called YouTube at all —
        # the daily sync is not running. Silence is not health.
        "stale": succ_age is None or succ_age > STALE_SUCCESS_SECONDS,
        "stale_after_seconds": STALE_SUCCESS_SECONDS,
        "never_recorded": succ is None and fail is None,
        "reading": (
            "`last_success` is the last time YOUTUBE ACCEPTED the credential, "
            "recorded from every successful call rather than only from an "
            "explicit probe — so its AGE also reports whether anything is "
            "calling YouTube at all. "
            "⚠️ `stale` and `failing` are DIFFERENT FAULTS. failing = the newest "
            "event was a rejection. stale = nothing has succeeded for "
            f"{STALE_SUCCESS_SECONDS // 3600}h, which with no failure recorded "
            "means the daily sync is not running. "
            "⚠️ `last_failure_kind` 'auth_expired' means do the reauth; "
            "'upstream_error' means YouTube had a bad moment and it may already "
            "be fine. Do not treat them the same."
        ),
    }


async def run_probe(host_id: str, timeout_seconds: float = 20.0) -> dict[str, Any]:
    """Make a REAL authenticated YouTube call and record the outcome.

    ⚠️ NEVER CALLED BY /health. A health check that hangs because YouTube is slow
    is worse than no probe — this lives behind its own endpoint and its own
    opt-in, and it carries a timeout so even that cannot hang forever.
    """
    import anyio

    from .tools import dj as dj_mod

    started = time.monotonic()
    try:
        with anyio.fail_after(timeout_seconds):
            # get_library_playlists is authenticated and small: an expired
            # cookie cannot satisfy it. Chosen over a search, which can succeed
            # unauthenticated and would report a dead credential as healthy.
            rows = await dj_mod._call(host_id, "get_library_playlists", limit=1)
    except TimeoutError:
        record_failure("upstream_error",
                       f"probe timed out after {timeout_seconds:.0f}s", source="probe")
        return {**summarise(), "probe_ran": True, "probe_ok": False,
                "probe_detail": f"timed out after {timeout_seconds:.0f}s"}
    except Exception as e:  # noqa: BLE001 — classified below, never propagated
        detail = str(e)
        # dj._call already classifies and prefixes; honour that rather than
        # re-deriving it, so one vocabulary describes the failure everywhere.
        kind = "auth_expired" if detail.startswith("auth_expired:") else (
            "upstream_error" if detail.startswith("upstream_error:")
            else classify(detail, getattr(getattr(e, "response", None), "status_code", None))
        )
        record_failure(kind, detail, source="probe")
        return {**summarise(), "probe_ran": True, "probe_ok": False,
                "probe_detail": detail[:400]}

    elapsed_ms = int((time.monotonic() - started) * 1000)

    # ⚠️ AN EMPTY LIBRARY IS NOT PROOF OF ANYTHING, AND IS NOT TREATED AS
    # SUCCESS. ytmusicapi can return an empty list where an unauthenticated or
    # half-authenticated session would too. Alex has ~43 playlists, so zero is
    # a signal rather than a state — reported as INCONCLUSIVE rather than
    # recorded as either outcome, because guessing wrong here either hides a
    # dead cookie or invents one.
    count = len(rows or [])
    if count == 0:
        return {**summarise(), "probe_ran": True, "probe_ok": None,
                "probe_detail": (
                    "the call succeeded but returned NO playlists. That is not "
                    "proof of success and not proof of failure — an "
                    "unauthenticated session can look like this too. Nothing "
                    "was recorded. Check the library in a browser."),
                "probe_elapsed_ms": elapsed_ms}

    # Force the write past the throttle: an explicit probe is exactly when the
    # timestamp must move.
    global _last_write_monotonic
    _last_write_monotonic = None
    record_success(source="probe")
    return {**summarise(), "probe_ran": True, "probe_ok": True,
            "probe_detail": f"read {count} playlist(s)",
            "probe_elapsed_ms": elapsed_ms}
