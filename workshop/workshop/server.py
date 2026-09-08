"""Starlette app. Wires the MCP Streamable-HTTP transport at ``/mcp``, adds
bearer-token auth via the SDK's built-in middleware, and serves ``/health``
and both variants of the protected-resource metadata document alongside it.

Uses the low-level ``mcp.server.Server`` because our tool contract is an
explicit ``input_schema`` dict per tool (spec §4), which doesn't map cleanly
to ``MCPServer.add_tool`` (that surface infers schemas from typed function
signatures). ``on_list_tools`` and ``on_call_tool`` callbacks let us serve
straight from the platform registry.

Auth wiring (Step 5, permissive pass):
  * ``AuthSettings(issuer_url, resource_server_url)`` + our
    ``SupabaseTokenVerifier`` are passed to ``streamable_http_app(...)``.
  * The SDK then applies ``AuthenticationMiddleware(BearerAuthBackend(...))``
    at the app level (harmless for unauthenticated routes — it extracts
    credentials if present, sets nothing if not) and wraps ``/mcp`` in
    ``RequireAuthMiddleware``, which returns 401 with the correct
    ``WWW-Authenticate: Bearer resource_metadata="..."`` header when a
    request has no valid bearer.
  * The SDK auto-serves ``/.well-known/oauth-protected-resource/mcp``
    (the path-suffixed variant, computed by inserting the well-known
    prefix ahead of ``resource_server_url``'s ``/mcp`` path).
  * We manually add ``/.well-known/oauth-protected-resource`` (the "root"
    variant) as a ``custom_starlette_route`` because clients probe both
    variants (spec §3.3) and the SDK only wires the one that matches the
    resource_server_url path.
  * ``/health`` remains unauthenticated permanently (spec §3.5), because
    ``custom_starlette_routes`` are outside the ``/mcp`` middleware wrapper.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from mcp.server import Server
from mcp.server.auth.settings import AuthSettings
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from pathlib import Path

from . import GIT_SHA, __version__, uptime_seconds
from . import platform as plat
from . import tools as _tools  # noqa: F401  — triggers @define_tool registration
from .auth import SupabaseTokenVerifier
from .config import Config
from .jobs import JobStore


log = logging.getLogger("workshop.server")


def _serialize_data(data: Any) -> str:
    # ``default=str`` covers datetimes, UUIDs, and dataclass-ish objects a
    # tool might legitimately return without forcing each handler to
    # pre-stringify. Anything that isn't stringifiable that way raises
    # TypeError and surfaces through on_call_tool's catch-all.
    return json.dumps(data, indent=2, default=str)


def _build_mcp_server(config: Config, job_store: JobStore) -> Server:
    mcp_log = logging.getLogger("workshop.mcp")

    async def on_list_tools(_request_ctx, _params):
        return ListToolsResult(
            tools=[
                Tool(
                    name=entry.name,
                    description=entry.description,
                    input_schema=entry.input_schema,
                )
                for entry in plat.get_registry().values()
            ]
        )

    async def on_call_tool(_request_ctx, params):
        # Build a fresh Ctx per call. `claims` stays {} until we wire a
        # request-state populator that copies the SDK-verified AccessToken's
        # claims into the Ctx; `jobs` is the shared JobStore built once at
        # app-assembly time.
        ctx = plat.Ctx(
            host_id=config.host_id,
            config=config,
            log=mcp_log,
            jobs=job_store,
            claims={},
        )

        try:
            data, meta = await plat.call_tool(
                params.name, params.arguments or {}, ctx
            )
        except plat.WorkshopError as e:
            mcp_log.info("tool %r raised %s: %s", params.name, type(e).__name__, e)
            return CallToolResult(
                content=[TextContent(type="text", text=str(e))],
                is_error=True,
            )
        except Exception as e:
            mcp_log.exception("tool %r crashed", params.name)
            return CallToolResult(
                content=[TextContent(type="text", text=f"Internal error: {e}")],
                is_error=True,
            )

        text = _serialize_data(data)
        if meta.get("truncated"):
            shown, total = meta["truncated"]
            text = plat.truncated_note(shown, total) + "\n\n" + text

        return CallToolResult(
            content=[TextContent(type="text", text=text)],
            is_error=False,
        )

    return Server(
        name="workshop",
        version=__version__,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )


def _build_metadata_document(config: Config) -> dict:
    # Static JSON, per RFC 9728 §3.2. `resource` MUST match the MCP server
    # URL exactly — including the `/mcp` path, which is what clients send as
    # the RFC 8707 `resource` parameter — so it derives from config.resource
    # (public_origin + MCP_PATH) and is never hardcoded per host.
    # `scopes_supported` is empty in pass 1; we're not enforcing scopes yet
    # and don't advertise anything we don't consume.
    return {
        "resource": config.resource,
        "authorization_servers": [config.supabase_issuer],
        "bearer_methods_supported": ["header"],
        "scopes_supported": [],
    }


def build_app(config: Config):
    """Return the Starlette ASGI app to serve.

    Routes at the top level, in order:
      * ``/health`` (unauthenticated, custom_starlette_route)
      * ``/.well-known/oauth-protected-resource``
        (unauthenticated, custom_starlette_route — the path-suffixed
        ``/mcp`` variant is served automatically by the SDK from
        resource_server_url)
      * ``/mcp`` (wrapped in RequireAuthMiddleware by the SDK)
    """

    metadata_doc = _build_metadata_document(config)

    async def health(_request: Request) -> Response:
        # Unauthenticated on purpose (spec §3.5). Returns nothing sensitive.
        return JSONResponse(
            {
                "host": config.host_id,
                "version": __version__,
                "git_sha": GIT_SHA,
                "uptime_seconds": uptime_seconds(),
                "tool_count": len(plat.get_registry()),
            }
        )

    async def credential(request: Request) -> Response:
        """Is the YouTube credential ALIVE — cached by default, probed on request.

        🛑 A SEPARATE ENDPOINT, NOT A FLAG ON /health. /health must stay instant:
        a health check that hangs because YouTube is slow is worse than no probe
        at all, and every monitor that touches it would inherit the hang.

        ⚠️ THE DEFAULT PATH MAKES NO NETWORK CALL. It reports what the Surface
        already recorded — last success, last failure, and the AGE of each — so
        the checker can say "last confirmed working 6 hours ago" without waiting
        on YouTube. `?deep=1` opts in to the real round trip.

        Unauthenticated like /health, and it returns no part of the credential:
        timestamps, a failure classification, and a scrubbed message.
        """
        from . import credential_probe

        deep = request.query_params.get("deep") in ("1", "true", "yes")
        if not deep:
            return JSONResponse({"host": config.host_id, "probed": False,
                                 **credential_probe.summarise()})
        result = await credential_probe.run_probe(config.host_id)
        return JSONResponse({"host": config.host_id, "probed": True, **result})

    async def metadata_root_variant(_request: Request) -> Response:
        # RFC 9728 lets clients construct the metadata URL two ways: from
        # the origin (root variant), and from the protected-resource URL
        # by inserting the well-known prefix between host and path
        # (path-suffixed variant). Serving both here — the SDK covers the
        # path-suffixed variant automatically now that resource_server_url
        # carries the /mcp path; we cover the root one so origin-derived
        # probes land somewhere real. Same JSON body either way.
        return JSONResponse(metadata_doc)

    verifier = SupabaseTokenVerifier(config)
    auth_settings = AuthSettings(
        # Supabase's `/auth/v1` prefix IS the issuer — its metadata lives
        # at /auth/v1/.well-known/oauth-authorization-server, not at the
        # domain root. Never point issuer_url at just the project origin.
        issuer_url=config.supabase_issuer,
        # `resource_server_url` — the SDK builds the metadata URL from
        # this by inserting /.well-known/oauth-protected-resource before
        # any path, and stamps it into both the served document's
        # `resource` field and the 401 WWW-Authenticate header. It MUST
        # carry the /mcp path (config.resource), or the token Claude
        # requests is bound to the wrong audience. That makes the SDK
        # serve the /mcp-suffixed variant; we add the root one ourselves.
        resource_server_url=config.resource,
        required_scopes=[],
    )

    # Job store: one instance for the process lifetime. Constructor runs
    # startup housekeeping (orphaned running-jobs → failed, retention
    # sweep) and starts the ThreadPoolExecutor. `data/workshop.db` is
    # gitignored per spec §5.3.
    data_dir = Path(__file__).resolve().parent.parent / "data"
    job_store = JobStore(db_path=data_dir / "workshop.db", config=config)

    mcp_server = _build_mcp_server(config, job_store)
    custom_routes = [
        Route("/health", health, methods=["GET"]),
        Route("/credential", credential, methods=["GET"]),
        Route(
            "/.well-known/oauth-protected-resource",
            metadata_root_variant,
            methods=["GET"],
        ),
    ]

    # DNS rebinding protection: the SDK auto-enables it for host="127.0.0.1"
    # with allowed_hosts limited to loopback names, which would 421 real
    # requests coming in through Cloudflare with Host: <public origin>.
    # Cloudflare Access + the JWT bearer IS our real security boundary;
    # nothing on the LAN can reach 127.0.0.1:7777 except cloudflared. We
    # keep the loopback names in the allowlist (so a local Inspector still
    # works) and add the public origin's host so tunnel traffic passes.
    from urllib.parse import urlparse
    public_host = urlparse(config.public_origin).netloc
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[
            "127.0.0.1:*", "localhost:*", "[::1]:*",
            public_host,
            f"{public_host}:*",
        ],
        allowed_origins=[
            "http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*",
            f"https://{public_host}",
        ],
    )

    log.info(
        "Workshop app assembled: %d tool(s) in registry, auth_mode=%s, "
        "public_origin=%s",
        len(plat.get_registry()),
        config.auth_mode,
        config.public_origin,
    )

    return mcp_server.streamable_http_app(
        streamable_http_path="/mcp",
        custom_starlette_routes=custom_routes,
        auth=auth_settings,
        token_verifier=verifier,
        transport_security=transport_security,
    )
