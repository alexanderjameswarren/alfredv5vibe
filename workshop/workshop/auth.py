"""Bearer-token verification against Supabase's JWKS.

Implements the MCP SDK's ``TokenVerifier`` Protocol
(``mcp.server.auth.provider.TokenVerifier``). The SDK wires the rest of the
resource-server surface — protected-resource metadata, 401 with
``WWW-Authenticate: Bearer resource_metadata="..."``, session state
population — provided ``streamable_http_app(...)`` is called with our
``token_verifier`` and an ``AuthSettings``.

Two operating modes per spec §3.4:

  ``permissive`` — verify the ES256 signature and ``exp``; log the FULL
      decoded claims with a loud banner; accept. Step 5's discovery pass:
      nobody could write the strict validator before observing what
      Supabase actually puts in a real token. NOT a resting configuration.

  ``strict`` — additionally enforce, based on Step 5's observations:
      * ``iss == config.supabase_issuer`` (Supabase's ``/auth/v1`` prefix)
      * ``aud == "authenticated"`` (the constant string Supabase issues to
        every authenticated user; the ``resource`` parameter is NOT honored
        by Supabase, so aud alone cannot distinguish Workshop tokens from
        Alfred tokens — this is why the sub allowlist below is not optional)
      * ``sub in config.allowed_subs`` (the actual single-user boundary;
        without it, any authenticated Supabase user in this project would
        pass — including tokens sitting in browser storage for the Alfred
        React app on this same project)

JWKS caching: ``PyJWKClient`` handles kid lookup, per-key caching, and — as
verified in its source — automatic re-fetch of the JWK set when a ``kid``
is not in the cached set. That is the "refetch on unknown kid" behaviour
spec §3.3 asks for. ``lifespan`` bounds cache age.

401 body deliberately does not leak claim detail. The SDK's
``RequireAuthMiddleware._send_auth_error`` writes only
``{"error": "invalid_token", "error_description": "Authentication required"}``;
our rejection reasons go to the local log at INFO/WARNING for operator
troubleshooting, never on the wire.
"""
from __future__ import annotations

import logging

import jwt
from jwt import PyJWKClient, PyJWKClientError
from mcp.server.auth.provider import AccessToken

from .config import Config


log = logging.getLogger("workshop.auth")

# JWKS TTL. PyJWKClient's unknown-kid refetch handles the fast case; this
# just bounds how stale the cached set can be in the absence of a miss.
# One hour is plenty for a project whose key material rotates rarely.
JWKS_LIFESPAN_SECONDS = 3600

# Observed value of Supabase's `aud` claim, Step 5 (permissive pass): a
# constant string issued to every authenticated user in a Supabase project.
# Not a list; not the RFC 8707 `resource` parameter (Supabase does not honor
# that). See docs/progress-workshop.md Step 5 notes for the raw claims dump.
SUPABASE_AUD = "authenticated"


class SupabaseTokenVerifier:
    """MCP ``TokenVerifier`` backed by a Supabase project's ES256 JWKS."""

    def __init__(self, config: Config):
        self.config = config
        # Supabase serves auth-server metadata at /auth/v1/.well-known/...
        # so the JWKS URI is under the same /auth/v1 prefix, not the domain
        # root. Do NOT try to fetch from https://<project>.supabase.co/.well-known/
        # (spec §3.2 — the root path 404s).
        self._jwks_uri = f"{config.supabase_issuer}/.well-known/jwks.json"
        self._jwks_client = PyJWKClient(
            self._jwks_uri,
            cache_keys=True,
            lifespan=JWKS_LIFESPAN_SECONDS,
        )
        log.info("SupabaseTokenVerifier initialised (mode=%s)", config.auth_mode)

    async def verify_token(self, token: str) -> AccessToken | None:
        # 1. Resolve the signing key by ``kid``. On cache miss, PyJWKClient
        # refetches the JWK set and retries — verified in pyjwt source.
        try:
            signing_key = self._jwks_client.get_signing_key_from_jwt(token)
        except PyJWKClientError as e:
            log.warning("auth: reject — JWKS lookup failed: %s", e)
            return None
        except Exception as e:
            log.warning("auth: reject — token header unreadable: %s", e)
            return None

        # 2. Verify signature and claim constraints. Strict mode adds
        # iss + aud enforcement per Step 5's observation; permissive mode
        # remains permissive so a rare re-run of the discovery pass still
        # works without code changes.
        strict = self.config.auth_mode == "strict"
        if strict:
            decode_options = {
                "verify_aud": True,
                "verify_iss": True,
                "require": ["exp", "iss", "aud", "sub"],
            }
            decode_kwargs = {
                "audience": SUPABASE_AUD,
                "issuer": self.config.supabase_issuer,
            }
        else:
            decode_options = {
                "verify_aud": False,
                "verify_iss": False,
                "require": ["exp"],
            }
            decode_kwargs = {}

        try:
            decoded = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256"],
                options=decode_options,
                **decode_kwargs,
            )
        except jwt.ExpiredSignatureError:
            log.info("auth: reject — token expired")
            return None
        except jwt.InvalidIssuerError:
            log.info("auth: reject — invalid iss (expected %r)",
                     self.config.supabase_issuer)
            return None
        except jwt.InvalidAudienceError:
            log.info("auth: reject — invalid aud (expected %r)", SUPABASE_AUD)
            return None
        except jwt.MissingRequiredClaimError as e:
            log.info("auth: reject — missing required claim: %s", e)
            return None
        except jwt.InvalidSignatureError:
            # Distinguished from other InvalidTokenError so tampering shows
            # up loud in the log — signature failure means someone tried,
            # not just that a token had drifted.
            log.warning("auth: reject — signature invalid (tampered token?)")
            return None
        except jwt.InvalidTokenError as e:
            log.info("auth: reject — token invalid: %s", e)
            return None

        # 3. Strict-mode sub allowlist. Runs AFTER decode succeeds so
        # tampered/expired/wrong-iss tokens don't get to log their sub. The
        # spec is explicit that this check is not optional: without it, any
        # authenticated user of this Supabase project (including anyone
        # holding an Alfred-app bearer for the same project) would pass.
        if strict:
            sub = decoded.get("sub")
            if sub not in self.config.allowed_subs:
                log.warning(
                    "auth: reject — sub %r not in ALLOWED_SUBS", sub
                )
                return None
            log.info("auth: accepted sub=%s client_id=%s",
                     sub, decoded.get("client_id"))

        # 4. Permissive-mode claims dump. Banner-wrapped WARNING so it
        # can't be mistaken for normal operation while scrolling. Read this
        # dump to write the strict validator against. NOT a resting
        # configuration on the Surface (spec §3.4).
        if not strict:
            log.warning("=" * 72)
            log.warning("AUTH PERMISSIVE MODE — token accepted after signature + exp only.")
            log.warning(
                "Review these claims before flipping to strict (Step 6) and "
                "before this host is exposed to real users."
            )
            log.warning("Full decoded token claims:")
            for k, v in decoded.items():
                log.warning("  %s = %r", k, v)
            log.warning("=" * 72)

        # 5. Build the ``AccessToken`` shape the SDK middleware expects.
        # ``claims`` is a first-class field on ``AccessToken``, so the
        # decoded dict travels through to any downstream Ctx populator
        # without a second decode.
        return AccessToken(
            token=token,
            client_id=str(
                decoded.get("client_id")
                or decoded.get("azp")
                or "unknown"
            ),
            scopes=[],
            expires_at=decoded.get("exp"),
            resource=self.config.resource,
            subject=decoded.get("sub"),
            claims=decoded,
        )
