"""``get_workshop_status`` — the first Workshop tool, and the answer to
"which connector is answering me". Built through ``@define_tool`` so the
platform module and the first tool land in one operation (spec §6).

Reports host identity, version metadata, uptime, auth mode, a dependency
probe for the future domain integrations, the full tool manifest, the
names (never values) of the env keys Workshop consumes, and a jobs
counter. Everything a live-triage check needs, nothing sensitive.
"""
from __future__ import annotations

import importlib
from typing import Any

from .. import GIT_SHA, START_TIME, __version__, uptime_seconds
from ..config import config_keys_present
from ..platform import Ctx, define_tool, get_registry
from .dj import credential_state


def _probe(name: str, extras: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return ``{available, version, ...extras}`` for a dependency. Missing
    packages are the norm today (music21 lands with the score tools;
    ytmusicapi with the DJ tools) — this MUST NOT raise. That's the entire
    point of the probe: learn about a broken install here, not mid-request
    at the top of a demucs job."""
    try:
        module = importlib.import_module(name)
    except Exception:
        base: dict[str, Any] = {"available": False, "version": None}
        if extras:
            base.update({k: None for k in extras})
        return base
    version = getattr(module, "__version__", None)
    base = {"available": True, "version": version}
    if extras:
        # Extras are resolved by the caller (see _ytmusicapi_probe). Seed the
        # keys here so the shape stays constant whether or not the dependency
        # imported — callers must never have to branch on key presence.
        base.update({k: None for k in extras})
    return base


def _ytmusicapi_probe() -> dict[str, Any]:
    """``_probe`` plus the DJ credential check (spec §7 phase 4).

    ``credential_readable`` means exactly what it says: a credential file is
    present and this process can read it, on this host. It is deliberately NOT
    a liveness check — proving YouTube still accepts the cookie needs a network
    round trip, and ``get_workshop_status`` runs at the top of every scheduled
    task (spec §7 phase 4, step 8), so it must stay fast and work offline.

    The field was called ``auth_valid`` and was renamed, because that name
    promised liveness this check does not deliver. A reader seeing
    ``auth_valid: true`` would reasonably conclude YouTube accepted the
    credential — and the gap between that belief and the truth IS the phase-6
    failure mode. An expired cookie reports ``credential_readable: true`` here
    and then fails at the DJ tool with ``auth_expired:``. Two different
    questions; this one answers only the cheap half, and now says so.

    What the cheap half is for: on the Surface the credential arrives by hand
    rather than by git, and the known failure is a file written by ``rdpuser``
    that ``alexa`` cannot read.
    """
    probe = _probe(
        "ytmusicapi", extras={"credential_readable": None, "auth_detail": None}
    )
    if not probe["available"]:
        return probe
    readable, detail = credential_state()
    probe["credential_readable"] = readable
    probe["auth_detail"] = detail
    return probe


def _jobs_snapshot(ctx: Ctx) -> dict[str, int]:
    # Step 7 replaces this with a real JobStore lookup. Until then, ctx.jobs
    # is None and the counters are zero — the shape stays constant across
    # steps so callers don't re-work integrations after Step 7.
    if ctx.jobs is None:
        return {"queued": 0, "running": 0, "finished_24h": 0}
    # Delegated to the store when it exists. Method name mirrored on the
    # future JobStore protocol.
    return ctx.jobs.status_snapshot()


@define_tool(
    name="get_workshop_status",
    tier=1,
    description=(
        "Return Workshop's host id, version, git sha, uptime, auth mode, a "
        "dependency probe, the tool manifest, the names of config keys "
        "loaded from .env, and a jobs counter. Use this to confirm which "
        "connector answered (host=desktop vs host=surface), verify a "
        "deployment landed (git_sha), and check whether optional deps like "
        "ytmusicapi have been installed on this host. "
        "`dependencies.ytmusicapi.credential_readable` reports only that a "
        "credential file exists and is readable HERE — it is not a liveness "
        "check, and an expired cookie still reports true. Only a DJ tool call "
        "returning `auth_expired:` proves YouTube has rejected it."
    ),
    input_schema={"type": "object", "properties": {}},
)
async def get_workshop_status(args: dict, ctx: Ctx) -> dict:
    manifest = [
        {"name": e.name, "tier": e.tier, "long_running": e.long_running}
        for e in get_registry().values()
    ]

    status = {
        "host": ctx.config.host_id,
        "version": __version__,
        "git_sha": GIT_SHA,
        "started_at": START_TIME.isoformat().replace("+00:00", "Z"),
        "uptime_seconds": uptime_seconds(),
        "auth_mode": ctx.config.auth_mode,
        "dependencies": {
            "music21": _probe("music21"),
            "ytmusicapi": _ytmusicapi_probe(),
        },
        "tools": manifest,
        "config_keys_present": config_keys_present(),
        "jobs": _jobs_snapshot(ctx),
    }
    return {"data": status}
