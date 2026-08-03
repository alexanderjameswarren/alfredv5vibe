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
  * The SDK auto-serves ``/.well-known/oauth-protected-resource`` (the
    "root" variant, computed from ``resource_server_url`` with no path).
  * We manually add ``/.well-known/oauth-protected-resource/mcp`` as a
    ``custom_starlette_route`` because clients probe both variants
    (spec §3.3) and the SDK only wires the one that matches the
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
    # Static JSON, per RFC 9728 §3.2. `resource` MUST match the connector's
    # server origin exactly, so it derives from config.public_origin — never
    # hardcoded. `scopes_supported` is empty in pass 1; we're not enforcing
    # scopes yet and don't advertise anything we don't consume.
    return {
        "resource": config.public_origin,
        "authorization_servers": [config.supabase_issuer],
        "bearer_methods_supported": ["header"],
        "scopes_supported": [],
    }


def build_app(config: Config):
    """Return the Starlette ASGI app to serve.

    Routes at the top level, in order:
      * ``/health`` (unauthenticated, custom_starlette_route)
      * ``/.well-known/oauth-protected-resource/mcp``
        (unauthenticated, custom_starlette_route — root variant is served
        automatically by the SDK when resource_server_url is set)
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

    async def metadata_mcp_variant(_request: Request) -> Response:
        # RFC 9728 lets clients construct the metadata URL two ways: from
        # the origin (root variant), and from the protected-resource URL
        # by inserting the well-known prefix between host and path
        # (path-suffixed variant). Serving both here — the SDK covers the
        # root variant automatically once resource_server_url is set on
        # AuthSettings; we cover the path-suffixed one so /mcp probes land
        # somewhere real. Same JSON body either way.
        return JSONResponse(metadata_doc)

    verifier = SupabaseTokenVerifier(config)
    auth_settings = AuthSettings(
        # Supabase's `/auth/v1` prefix IS the issuer — its metadata lives
        # at /auth/v1/.well-known/oauth-authorization-server, not at the
        # domain root. Never point issuer_url at just the project origin.
        issuer_url=config.supabase_issuer,
        # `resource_server_url` — the SDK builds the metadata URL from
        # this by inserting /.well-known/oauth-protected-resource before
        # any path. Passing the bare origin (no /mcp) makes the SDK serve
        # the root variant; we add the /mcp-suffixed variant ourselves.
        resource_server_url=config.public_origin,
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
        Route(
            "/.well-known/oauth-protected-resource/mcp",
            metadata_mcp_variant,
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
