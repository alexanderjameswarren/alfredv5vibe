"""Config: env loading, host identity, origin derivation.

Every value here has a matching key in `.env.example`. Loading happens once
at process start (via `python-dotenv` in `run.py`); this module reads from
`os.environ` after that. `.env` is per-host and never committed — that's
what makes `git reset --hard` on the Surface a safe operation.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


VALID_AUTH_MODES = {"strict", "permissive"}


@dataclass(frozen=True)
class Config:
    host_id: str
    port: int
    public_origin: str
    auth_mode: str
    supabase_issuer: str
    allowed_subs: frozenset[str]

    @property
    def resource(self) -> str:
        # The `resource` value advertised in protected-resource metadata,
        # sent as the `resource` parameter in auth flows, and compared against
        # the `aud`/`resource` claim in strict mode. Derived from public_origin
        # so desktop and Surface both work without hardcoding either hostname.
        return self.public_origin


def _required(k: str) -> str:
    v = os.environ.get(k, "").strip()
    if not v:
        raise RuntimeError(f"Missing required env var: {k}")
    return v


def load_config() -> Config:
    subs_raw = _required("ALLOWED_SUBS")
    subs = frozenset(s.strip() for s in subs_raw.split(",") if s.strip())
    if not subs:
        raise RuntimeError("ALLOWED_SUBS parsed to an empty set")

    auth_mode = _required("WORKSHOP_AUTH_MODE").lower()
    if auth_mode not in VALID_AUTH_MODES:
        raise RuntimeError(
            f"WORKSHOP_AUTH_MODE must be one of {sorted(VALID_AUTH_MODES)}, "
            f"got {auth_mode!r}"
        )

    return Config(
        host_id=_required("WORKSHOP_HOST_ID"),
        port=int(_required("WORKSHOP_PORT")),
        public_origin=_required("WORKSHOP_PUBLIC_ORIGIN").rstrip("/"),
        auth_mode=auth_mode,
        supabase_issuer=_required("SUPABASE_ISSUER").rstrip("/"),
        allowed_subs=subs,
    )


def config_keys_present() -> list[str]:
    """Env-key names actually consumed. Values are never returned — this list
    feeds `get_workshop_status.config_keys_present` (spec §6)."""
    return [
        "WORKSHOP_HOST_ID",
        "WORKSHOP_PORT",
        "WORKSHOP_PUBLIC_ORIGIN",
        "WORKSHOP_AUTH_MODE",
        "SUPABASE_ISSUER",
        "ALLOWED_SUBS",
    ]
