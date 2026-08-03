# Progress: Workshop

## Status: Step 9 (MANUAL, FINAL) — Surface deployment, handed off to human

- Technical spec: `docs/technical-spec-workshop.md`
- Manual setup: `docs/workshop-manual-setup.md`

Steps marked **MANUAL** are done by the human. The CLI stops and waits.

---

### Step 0 — MANUAL: desktop prerequisites

- [ ] Python 3.11+ installed, `python --version` confirms
- [ ] Do NOT create the tunnel yet

---

### Step 1 — Scaffold and health

- [x] `workshop/` folder structure per spec §7
- [x] `requirements.txt` with pinned versions
- [x] `.env.example` committed; `.gitignore` covers `.env`, `data/`, `.venv/`
- [x] `config.py` — loads env, derives public origin, exposes host id
- [x] `server.py` — Starlette app with `GET /health` (unauthenticated)
- [x] `run.py` — uvicorn on `127.0.0.1:${WORKSHOP_PORT}`
- [x] Logging to `data/workshop.log` and stdout

**Verify:** `python run.py`, then in another window
`Invoke-RestMethod http://127.0.0.1:7777/health` returns host, version, git sha,
uptime, tool count.

---

### Step 2 — Platform module

- [x] `platform.py`: `define_tool`, `Ctx`, `clamp_limit`, `envelope`
- [x] Tool registry populated at import
- [x] Tier 3 without `confirmed: true` returns a proposal, does not execute
- [x] `GuardrailError` (terminal wording, verbatim) vs `OperationalError` (retryable,
      no do-not-retry language)
- [x] Schema-parity assertion at registration: every key the handler reads is in
      `input_schema`
- [x] Unit tests for tier gating and clamping

**Verify:** run the tests. Show me the tier-3 proposal output.

---

### Step 3 — MCP mount and first tool

- [x] MCP server mounted at `/mcp`
- [x] `list_tools` served from the registry
- [x] `call_tool` routes through `define_tool`, emits `envelope.data` **bare**
- [x] Truncation NOTE prepended when `meta.truncated`
- [x] `tools/status.py` — `get_workshop_status` per spec §6
- [x] Dependency probe handles missing packages without raising
- [x] `config_keys_present` lists names only, never values

**Verify:** point MCP Inspector at `http://127.0.0.1:7777/mcp`. It lists one tool;
calling it returns the status object with `host: desktop`.

---

### Step 4 — MANUAL: Cloudflare tunnel, desktop

- [x] Zero Trust org created (Free)
- [x] Tunnel `workshop-dev` created, installed as Windows service
- [x] Public hostname `workshop-dev.alexanderjameswarren.com` → `127.0.0.1:7777` (HTTP)
- [x] `https://workshop-dev.alexanderjameswarren.com/health` returns the same JSON

---

### Step 5 — Auth, pass 1 (permissive)

- [x] `auth.py`: `/.well-known/oauth-protected-resource` and the `/mcp`-suffixed variant
- [x] `resource` derived from config, not hardcoded
- [x] Unauthenticated `/mcp` → 401 with
      `WWW-Authenticate: Bearer resource_metadata="..."`
- [x] `PyJWKClient` against Supabase JWKS, TTL cache, refetch on unknown `kid`
- [x] Verify ES256 signature and `exp`
- [x] **`WORKSHOP_AUTH_MODE=permissive`: log full decoded claims, then accept**
- [x] `/health` remains unauthenticated

**Verify (MANUAL):** register the connector per manual-setup Phase C with **blank**
OAuth fields. Sign in with Google. Then start a **fresh conversation**, call
`get_workshop_status`, and paste me the logged claims.

---

### Step 6 — Auth, pass 2 (strict)

- [x] Enforce `iss`, `exp`, and whatever `aud` was actually observed
- [x] `ALLOWED_SUBS` check against `26f0707f-b586-4a3e-841c-8c313d6ab1e5`
- [x] `WORKSHOP_AUTH_MODE=strict` is the default in `.env.example`
- [x] Rejections log the reason; the 401 body does not leak claim detail

**Verify:** tool call still succeeds. Then hand-edit a token's payload and confirm
401. Then set `ALLOWED_SUBS` to a different uuid and confirm 401.

---

### Step 7 — Async jobs

- [x] `jobs.py`: SQLite store per spec §5.3, schema created on startup
- [x] `ThreadPoolExecutor`, 2 workers
- [x] `long_running=True` in `define_tool` enqueues and returns
      `{job_id, status, poll_after_seconds}`
- [x] `get_job_status` (tier 1)
- [x] `list_jobs` (tier 1) with `clamp_limit`
- [x] Orphaned `running` jobs marked `failed` ("interrupted by restart") on startup
- [x] Jobs finished >7 days ago deleted on startup
- [x] Temporary `_debug_sleep` tool, `long_running=True`

**Verify:** call `_debug_sleep(30)`, get a job id immediately, poll to `succeeded`.
Then call it again and kill the process mid-run — on restart the job reads `failed`,
not `running`.

---

### Step 8 — Clean up

- [x] `_debug_sleep` removed
- [x] `README.md` in `workshop/` — what it is, how to run, how to add a tool
- [x] `get_workshop_status` reports exactly 3 tools

**Verify:** fresh conversation, tool count is 3.

---

### Step 9 — MANUAL: Surface deployment

- [ ] Sleep disabled on AC
- [ ] Python + Git installed
- [ ] SSH deploy key (read-only) added to GitHub
- [ ] Sparse checkout of `workshop/` at `C:\workshop-repo`
- [ ] venv + requirements installed
- [ ] `.env` with `WORKSHOP_HOST_ID=surface`, `AUTH_MODE=strict`
- [ ] Tunnel `workshop` → `workshop.alexanderjameswarren.com`
- [ ] Scheduled task `Workshop` running **as the user**, at startup, restart on failure
- [ ] Connector "Workshop (Surface)" registered
- [ ] `refresh.ps1` saved outside the repo tree, shortcut pinned to Start

**Verify:** tap Refresh Workshop. It reports HEALTHY with `host=surface`. Ask Claude
to call `get_workshop_status` on each connector and confirm one says `desktop` and
the other `surface`. Reboot the Surface and confirm Workshop comes back without login.

---

### Notes

_Decisions and issues found during execution._

**Step 1 — Scaffold and health**

- **Layout mirrors spec §7 exactly.** Outer `workshop/` holds `run.py`, `requirements.txt`, `.env.example`, `.gitignore`. Inner `workshop/workshop/` is the Python package (`__init__.py`, `config.py`, `server.py`, `tools/__init__.py`). `data/` created at import time by `run.py`, gitignored. Not written yet (later steps): `platform.py`, `auth.py`, `jobs.py`, `tools/status.py`, `tools/jobs.py`, `README.md`. Skeleton is what Step 1 requires — Step 8 owns the README.
- **Deps installed via full `pip install` then `pip freeze > requirements.txt`.** Pinning transitive deps too, not just the direct list from spec §7. On a headless Surface install any drift in a transitive would be undetectable until it broke something; explicit pins are the whole point. Direct deps requested: `mcp`, `uvicorn`, `starlette`, `pyjwt[crypto]`, `httpx`, `python-dotenv`. Resolver pulled 34 packages total.
- **`starlette==1.3.1` and `mcp==2.0.0`.** Both look surprising versus prior public versions. Whatever the current resolver picked as compatible for `mcp==2.0.0` is what shipped; the Starlette API surface I use (`Starlette`, `Route`, `JSONResponse`, `Request`) is stable across the 0.x → 1.x jump, and it started cleanly. Flagging in case Step 2 or Step 3 hit an API surprise.
- **`.env` created alongside `.env.example` for local dev.** Both live in `workshop/`; `.env` is gitignored, `.env.example` is committed. Default values in the local `.env` match `.env.example` — hooked up so `python run.py` works with no additional setup on the desktop. Kept `WORKSHOP_AUTH_MODE=strict` even though auth isn't wired yet in Step 1; permissive is only ever flipped on for the Step 5 discovery pass and must not become a resting default anywhere.
- **`Config` is a frozen dataclass, not Pydantic.** `pydantic` is pulled in via MCP but the config surface is small and I don't want any runtime validation ambiguity. Explicit `_required(key)` helper raises with the missing key name — an unset var fails at load, not somewhere downstream. `resource` property derives from `public_origin.rstrip("/")` so trailing slashes don't quietly break exact-match comparisons in Step 5's auth check.
- **`ALLOWED_SUBS` is a `frozenset[str]`.** Comma-parsed at load. Even though only one uuid is authorized today, using a set makes single vs. many uniform and keeps the O(1) membership check idiomatic for Step 6.
- **`config_keys_present()` returns names only.** `get_workshop_status` (Step 3) reads this. Deliberately not `list(os.environ.keys())` — that would leak that PATH, USERNAME, etc. exist. It returns the exact static list of keys Workshop consumes.
- **Git SHA is captured once at import.** `subprocess.run(["git", "rev-parse", "HEAD"], timeout=2)`, cached at module load. `.git` lives at the repo root; git walks up from cwd, so this works both when Workshop starts from `workshop/` (desktop) and from `C:\workshop-repo\workshop\` (Surface sparse checkout). Returns `"unknown"` on any failure — no reason for a health endpoint to crash because git is missing on a stripped install.
- **Uptime cached from `START_TIME` at module import.** `datetime.now(timezone.utc)`. Same reason — cheap, deterministic, and `/health` should never do I/O beyond serving.
- **Bind to `127.0.0.1`, not `0.0.0.0`.** Cloudflared is the only thing that talks to Workshop; binding globally would open a second, unauthenticated door on the LAN. The JWT check (Step 5+) is behind the tunnel, not on the loopback socket.
- **Logging owned by `run.py`, not uvicorn.** Root logger, INFO, both a FileHandler (`data/workshop.log`, utf-8) and a StreamHandler (stdout). `log_config=None` on `uvicorn.run` so uvicorn's default config doesn't fight us — uvicorn logs still flow through the same handlers because they emit via the root logger.
- **`load_dotenv` runs before any `workshop.*` import.** `load_config` reads `os.environ` eagerly at call time, and if a `workshop.*` module were imported first it could snapshot env values before dotenv populated them. Not an issue today but a foot-gun to avoid before Step 3 lands module-level state.
- **Local smoke test passed.** Server started on 127.0.0.1:7777. `curl` against `/health` returned `{"host":"desktop","version":"0.1.0","git_sha":"d10aeea","uptime_seconds":7,"tool_count":0}`. Log file mirrors stdout as expected. `tool_count: 0` is correct — the registry doesn't exist yet.

**Step 2 — Platform module**

- **All of `platform.py` lands in one file.** Errors + `Ctx` + registry + `define_tool` + `call_tool` + `clamp_limit` + envelope helpers. Considered splitting `errors.py` out but decided against it — the spec explicitly lists all six concerns as "platform.py". Splitting would make it harder to see the taxonomy at a glance and would fork from the TS shape unnecessarily.
- **`GuardrailError` auto-appends the terminal clause.** Callers supply the specific reason (`Budget cap of 20 calls hit`, `LOOP DETECTED: same call, same result`), and the class ensures `Do NOT retry — retrying will not change the result. Stop and report to the user.` is present exactly once. If the caller pre-composed the message with the clause already in it, we detect that and don't duplicate. This is the "verbatim" enforcement — a future caller who writes `GuardrailError("budget hit")` still gets the correct terminal wording.
- **`OperationalError` REJECTS do-not-retry wording at construction.** Any message containing `do not retry` / `don't retry` / `no retry` / `not retry` raises `ValueError` pointing the raiser at `GuardrailError`. This is the second half of spec §4.3 — "Stamping 'do not retry' on a transient error suppresses a retry that should happen." Enforced at raise time, not at emit time, so the mistake surfaces during development rather than at the model.
- **Schema-parity check is AST-based.** `_statically_read_arg_keys(handler)` `inspect.getsource` → `ast.parse` → walks for `args["k"]` and `args.get("k", ...)`. Runs at decorator invocation, i.e. at import. Catches the common pattern; documented limitation: handlers that compute keys at runtime (`args[k]` where `k` is a variable) escape the check. Fine — that pattern is itself the anti-pattern the check is preventing. Tool handlers should be pattern-literal on args. `'confirmed'` is exempted because it's a platform-owned key consumed by the tier-3 gate before dispatch.
- **`confirmed` is `is True`, not truthy.** `args.get("confirmed") is True` — the string `"true"`, integer `1`, list `[True]`, etc. all fail the gate. Tested explicitly with `{"confirmed": "true"}` → proposal, not execute. This is defence against a confused model or client that JSON-encodes a boolean as a string; the gate is the last thing between the user and a destructive action, so tight equality is right here.
- **Tier-3 proposal shape** — `{kind, tool, description, args, message}`. `kind: "tier_3_proposal"` is a discriminator so the MCP layer or a client shell can render it distinctly if desired; `args` is echoed back with `confirmed` stripped so the model can compose the follow-up call without hunting for what to re-send.
- **`long_running=True` currently raises `OperationalError`.** Step 7 wires the job store. Until then, a handler that declares itself long-running at import (i.e. in a future PR that jumps ahead) will register successfully but fail loudly at first dispatch — not silently execute inline. Better a loud failure at first call than a silent thread-blocking regression.
- **Envelope is `{data, meta}` — validated at dispatch.** Handlers that return a non-dict, or a dict missing `data`, get a `TypeError` / `ValueError` from `call_tool`. The `meta` dict may carry `truncated: (shown, total)` (Step 3 renders the NOTE prefix in front of the payload text) and can be extended in future without changing the wire shape.
- **`Ctx` uses `Any` for `jobs`.** `JobStore` is a Step 7 artifact and shouldn't force a premature import. Field is present now so tools authored in Steps 3–6 don't need to change signature when Step 7 lands.
- **Tests: stdlib `unittest`, not pytest.** No dev-dep on the Surface; the runner works out of the box on any Python 3.11+. 30 tests, all green. Run: `python -m unittest discover tests` from `workshop/`. `_reset_registry_for_tests()` is called in every `setUp` to prevent cross-test contamination — the registry is module-level and normally immutable at runtime, but tests need to register-then-tear-down.
- **Live tier-3 proposal captured** (for a synthetic `delete_song_family` tool):
  ```json
  {
    "kind": "tier_3_proposal",
    "tool": "delete_song_family",
    "description": "Deletes a song and every simplified/drill descendant. Superseding, irreversible.",
    "args": {
      "family_root_id": "abc-123-def",
      "reason": "accidental duplicate"
    },
    "message": "Tool 'delete_song_family' is tier 3 (destructive, superseding, or semantically significant). Nothing has been executed. To proceed, re-call this tool with `confirmed: true` in the arguments."
  }
  ```
  Handler was `raise AssertionError(...)` and did not fire — confirmed the gate intercepts.

**Step 3 — MCP mount and first tool**

- **Chose the low-level `mcp.server.Server` over `MCPServer`.** `MCPServer.add_tool(fn, ...)` infers the input schema from a typed Python signature — a nice convenience for greenfield tools but a foreign shape for us: our contract is an explicit `input_schema` dict per `@define_tool`, and every tool already lives in a platform-owned registry. Bridging by dynamically synthesizing functions with the right signatures would be a lot of AST plumbing to achieve nothing that mattered. `Server(on_list_tools=..., on_call_tool=...)` lets me serve straight from `plat.get_registry()`. Same file (`workshop/server.py`) still returns a plain Starlette app from `mcp_server.streamable_http_app(...)`.
- **`/health` rides `custom_starlette_routes`.** The SDK's `streamable_http_app` accepts a list of extra Starlette Routes and mounts them at the top of the same app as `/mcp`. That means one uvicorn, one app, one origin — the URL structure the connector expects (`https://host/mcp` for MCP, `https://host/health` for probes) falls out for free. The SDK explicitly documents that custom routes are exempt from auth, which is what `/health` needs (spec §3.5).
- **MCP `Tool` vs. our `ToolEntry`.** The MCP wire type has `{name, description, input_schema, ...}` but no `tier` / `long_running` fields. The tier is enforced BY the gate at dispatch (via `platform.call_tool`), so the manifest doesn't need to advertise it to the client. `get_workshop_status` DOES re-surface tier and long_running in its own payload — so anyone auditing "which tier is that tool?" can query the server for the answer without reading source.
- **Envelope emitted bare, verified.** Handlers return `{data, meta}`, `plat.call_tool` returns `(data, meta)`, `on_call_tool` `json.dumps(data, indent=2, default=str)` and stuffs it in a single `TextContent`. The MCP client saw only the `data` payload, not the envelope wrapper — exactly as spec §4.1 demands. Truncation NOTE is prepended before the JSON when `meta["truncated"]` is set (Step 3 has no truncating tool to exercise this end-to-end; unit-tested in Step 2 via `truncated_note()`).
- **`json.dumps(default=str)`.** Covers datetimes and UUIDs a tool might legitimately hand back without every handler pre-stringifying. If a tool returns something not stringifiable via `default=str`, the exception surfaces through the on_call_tool catch-all as an "Internal error: ..." message with `is_error=True` — noisy failure beats silent 500.
- **Error handling in `on_call_tool` — two layers.** `plat.WorkshopError` (Guardrail, Operational, SchemaParity) surfaces with the pre-vetted phrasing intact, `is_error=True`. Anything else is caught, logged with traceback (via `.exception`), and returned as `Internal error: {e}` — no do-not-retry wording, so a caller may retry if they see a transient stack in the logs. Never re-raise past `on_call_tool` or the whole MCP session tears down.
- **Ctx built fresh per call.** `claims={}` (Step 5+ populates from the verified bearer), `jobs=None` (Step 7 wires the SQLite store), `job_id=None` (only set from inside a job worker in Step 7). Everything else — host_id, config, log — is closed over from `build_app(config)`, matching the "no global reaching" rule in the platform contract.
- **`get_workshop_status` uses `_probe(name, extras=...)` for dependencies.** `importlib.import_module` inside a bare `except Exception` — never raises. Returns `{available: False, version: None, ...extras}` for missing packages, so ytmusicapi's `auth_valid: null` slot is present even when the package isn't installed. That's the shape stability the model needs.
- **`config_keys_present()` returns the static list from `config.py`.** Not `os.environ.keys()` — that would leak PATH, USERNAME, etc. Six keys today (`WORKSHOP_HOST_ID`, `WORKSHOP_PORT`, `WORKSHOP_PUBLIC_ORIGIN`, `WORKSHOP_AUTH_MODE`, `SUPABASE_ISSUER`, `ALLOWED_SUBS`), all six always loaded (each is required — load_config raises on any missing).
- **`_jobs_snapshot(ctx)` returns zeros pre-Step-7.** Shape is `{queued, running, finished_24h}`; when Step 7 lands, `ctx.jobs is not None` and we call `ctx.jobs.status_snapshot()`. Method name pre-committed in the comment so Step 7 knows what to name.
- **Smoke test via the SDK's own `streamable_http_client`.** Not curl — MCP over Streamable HTTP requires session management (initialize → session id → subsequent calls) and the SDK client handles that. First run failed on an import name typo (`streamablehttp_client` → `streamable_http_client`) and a return-arity mismatch (client returns `(read, write)` in this version, not the three-tuple I typed from muscle memory). Fixed and green: `list_tools` returned `get_workshop_status`, `call_tool` returned the full status object with `host: desktop`, `is_error: False`. Log line captured showing tool count 1.
- **`/health` now reports `tool_count: 1`.** Import of `.tools` at module load in `server.py` triggers the `@define_tool` in `tools/status.py`, so by the time `build_app` runs, the registry is populated. Verified: `curl http://127.0.0.1:7777/health` → `{"host":"desktop","version":"0.1.0","git_sha":"d10aeea","uptime_seconds":7,"tool_count":1}`.
- **MCP SDK note for later steps.** The SDK exposes `mcp.server.auth` with `TokenVerifier` / `AuthSettings` — spec §3.3 asked me to check for a built-in resource-server auth surface. Answer: yes, it exists. The `Server.streamable_http_app(...)` call already accepts `auth`, `token_verifier`, and `auth_server_provider` params. Step 5 will decide whether to use the SDK's `TokenVerifier` protocol or wire our own middleware; noting here so I don't rediscover it.

**Step 5 — Auth pass 1 (permissive)** — CLI portion

- **Used the SDK's built-in resource-server auth** — spec §3.3 asked me to prefer it if present, and it is. Wiring: `AuthSettings(issuer_url=config.supabase_issuer, resource_server_url=config.public_origin, required_scopes=[])` + a `SupabaseTokenVerifier` passed to `streamable_http_app(auth=..., token_verifier=...)`. The SDK then applies `AuthenticationMiddleware(BearerAuthBackend(...))` app-wide (harmless for `/health` — it only extracts, never enforces) and wraps `/mcp` in `RequireAuthMiddleware`, which returns 401 with the correct `WWW-Authenticate` header on missing/invalid tokens. Zero custom middleware code.
- **Manually added the /mcp-suffixed metadata variant.** The SDK's `create_protected_resource_routes(resource_url=<origin>, ...)` serves only ONE route derived from the origin's path — with `resource_server_url=<origin>` (no /mcp path) that's `/.well-known/oauth-protected-resource`. The path-suffixed variant `.../oauth-protected-resource/mcp` (spec §3.3: "clients probe both") is added as a `custom_starlette_route` returning the same JSON. Both variants verified live via the tunnel.
- **`SupabaseTokenVerifier` implements MCP's `TokenVerifier` Protocol.** Constructor takes our `Config`; `verify_token(token)` returns `AccessToken | None`. Steps: (1) `PyJWKClient.get_signing_key_from_jwt` — refetches JWK set on unknown-kid automatically (source-verified in pyjwt), so key rotation "just works"; (2) `jwt.decode(..., algorithms=["ES256"], options={"verify_aud": False, "verify_iss": False, "require": ["exp"]})` — permissive-mode signature + exp check only; aud/iss stay unverified because we haven't observed what Supabase actually puts in them; (3) if `config.auth_mode == "permissive"`, dump the full decoded claims at WARNING with a banner-wrapped block; (4) build the `AccessToken(claims=decoded, subject=sub, expires_at=exp, resource=config.resource, ...)`.
- **JWKS TTL 1 hour, refetch on unknown-kid.** `PyJWKClient(uri, cache_keys=True, lifespan=3600)`. The unknown-kid path (verified in pyjwt source: cache miss → `get_signing_keys(refresh=True)` → retry) means rotated keys land automatically without waiting for TTL expiry — exactly the behaviour spec §3.3 asked for. Handwritten cache invalidation would just be re-implementing this less well.
- **Local .env flipped to `WORKSHOP_AUTH_MODE=permissive`.** `.env.example` stays `strict` (spec: strict is the resting configuration). The flip is temporary — Step 6 changes it back after we read the logged claims.
- **DNS-rebinding protection preemptively adjusted.** The SDK's `streamable_http_app` auto-enables rebinding protection when `host="127.0.0.1"` (the default), with `allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*"]`. That would 421 real authenticated requests coming in with `Host: workshop-dev.alexanderjameswarren.com` from Cloudflare. Unauthenticated 401s escape because `RequireAuthMiddleware` sits above the streamable-http body handler, so rebinding checks don't run — but the moment a real bearer arrives it would fail. Fix: passed explicit `TransportSecuritySettings` with the public origin added to `allowed_hosts` and `allowed_origins`. Rebinding still protects against a browser attacker, but Cloudflare's Host header now passes. Rationale: our real auth boundary is Cloudflare + JWT bearer, not the raw loopback socket; nothing on the LAN can reach 127.0.0.1:7777 except cloudflared.
- **Stale server on port 7777 killed once.** During first smoke test, the port was already bound — the user had left a `python run.py` running from Step 4 verification. My server exited with WinError 10048. Investigated: Get-NetTCPConnection → PID 40968 → confirmed `python.exe`, killed with Stop-Process. Restart clean. Noting so future step-transitions include a "kill anything on 7777 first" reflex.
- **Local + public smoke tests, all four checks green.** Local: /health 200, /mcp POST no token → 401 with `WWW-Authenticate: Bearer error="invalid_token", ..., resource_metadata="https://workshop-dev.alexanderjameswarren.com/.well-known/oauth-protected-resource"`, both metadata variants return correct JSON. Public tunnel: same four checks, all green. Bonus check: bogus bearer through the tunnel also 401s correctly (as expected — token verify rejects before rebinding could bite).
- **CLI portion done; MANUAL portion (Phase C connector registration + fresh-conversation tool call) is handed off to the human.**

**Step 5 — Auth pass 1 (permissive)** — MANUAL portion, observed claims

- **Registration via DCR worked with blank OAuth fields, first try.** Claude.ai self-registered against Supabase's `registration_endpoint`. The connector then obtained a token and called `get_workshop_status` on a fresh conversation. No client-id-required prompt; no follow-up config needed.
- **Full decoded claims (Step 6's input):**
  ```
  iss           = 'https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1'
  sub           = '26f0707f-b586-4a3e-841c-8c313d6ab1e5'       ← matches ALLOWED_SUBS exactly
  aud           = 'authenticated'                                ← string constant, NOT the RFC 8707 resource
  exp           = 1785784755
  iat           = 1785781155                                     ← exp − iat = 3600 → 1h lifetime
  email         = 'alexanderjameswarren@gmail.com'
  phone         = ''
  app_metadata  = {'provider': 'google', 'providers': ['google']}
  user_metadata = { full Google profile }
  role          = 'authenticated'
  aal           = 'aal1'                                          ← auth assurance level
  amr           = [{'method': 'oauth_provider/authorization_code', 'timestamp': 1785781155}]
  session_id    = 'b496afe4-b55f-4272-9a6c-358d2a8feb53'
  is_anonymous  = False
  client_id     = '2ae8d1b9-add2-432d-bc94-9b1bc61379bf'          ← Claude's DCR-registered client
  scope         = 'email'                                         ← Supabase issued only email, not openid
  ```
- **Confirmed: Supabase does NOT honor the `resource` parameter.** No `resource` claim in the token. The `aud` claim is a fixed string, not per-resource. Every token from this Supabase project has `aud="authenticated"` — including any token sitting in a browser for Alfred's React app. This is what makes the `sub` allowlist non-optional (spec §3.4). Enforcing `aud` catches the "totally wrong project" case only; enforcing `sub` catches the "another user of this project" case.
- **Step 6 checks to implement:** `iss == config.supabase_issuer` (exact match), `aud == "authenticated"` (exact match), `sub in config.allowed_subs`. Signature + exp are already covered by pyjwt. No client_id or scope enforcement.

**Step 6 — Auth pass 2 (strict)**

- **`auth.py` gained a strict branch.** When `config.auth_mode == "strict"`: pyjwt is invoked with `verify_aud=True`, `verify_iss=True`, `audience="authenticated"`, `issuer=<config.supabase_issuer>`, `require=["exp", "iss", "aud", "sub"]`. That single `jwt.decode` call handles the iss/aud/exp/signature checks; a post-decode `if sub not in config.allowed_subs: return None` closes the single-user boundary. The permissive-mode dump path is preserved but gated to `auth_mode != "strict"`, so a rare re-run of the discovery pass still works by flipping `.env` without editing code.
- **`SUPABASE_AUD = "authenticated"` is a module-level constant.** Named, commented, and points back at the progress-doc claims dump — anyone reading auth.py in six months can see WHY this value and where it was observed. Not inlined at the call site.
- **Distinguished exception classes for observability.** `InvalidSignatureError` logs at WARNING (tampering signal); `ExpiredSignatureError` / `InvalidIssuerError` / `InvalidAudienceError` / `MissingRequiredClaimError` log at INFO (routine rejections). All return `None` — from the wire the client sees the same generic 401. The distinction only affects local log noise, where it matters: a spike of signature-invalids is worth alerting on, a spike of expired-tokens is not.
- **401 body does not leak claim detail** (spec's "does not leak" bullet). Verified by reading the SDK's `RequireAuthMiddleware._send_auth_error` in Step 5 — it writes `{"error": "invalid_token", "error_description": "Authentication required"}` unconditionally. Our rejection reasons stay in `data/workshop.log` for operator troubleshooting; nothing about them reaches the client.
- **`.env.example` already said `WORKSHOP_AUTH_MODE=strict`** (set that way from Step 1). Only the local `.env` needed flipping back from `permissive` → `strict` for this step. Confirmed via inspection.
- **Automated negative-path check.** Two bogus bearers fired at `/mcp` from the CLI: (1) `Bearer notavalidjwt` → `auth: reject — token header unreadable: Not enough segments`, HTTP 401. (2) A syntactically-valid JWT with a random `kid` and fake signature → `auth: reject — token header unreadable: Invalid crypto padding`, HTTP 401. Both cases exit before signature verification — pyjwt bails at header parse — so the specific "signature invalid" warning didn't fire in these probes. Signature-tampering with a well-formed token would need a fresh live Supabase JWT to tamper (they expire in 1h and I don't have one to hand); the sub-allowlist test below is easier and covers a semantically equivalent negative path.
- **Manual verification handed off:** (a) fresh-conversation call still succeeds and returns `auth_mode: "strict"`; (b) local .env with wrong ALLOWED_SUBS → same call 401s with `auth: reject — sub '26f...' not in ALLOWED_SUBS` in the log; (c) restore .env, restart, retry → succeeds. Server is running now in strict mode with the real `ALLOWED_SUBS`.

**Step 6 — verified via three-part manual check.** (a) Fresh conversation → `get_workshop_status` returned `auth_mode: "strict"`, log line `auth: accepted sub=26f0707f-b586-4a3e-841c-8c313d6ab1e5 client_id=2ae8d1b9-...`. (b) `.env` flipped to `ALLOWED_SUBS=00000000-0000-0000-0000-000000000000`, restart, retry → Claude reported the tool call failed with an auth error (401 on the wire). (c) `.env` restored, restart, retry → success again.

**Step 7 — Async jobs**

- **File layout.** New `workshop/jobs.py` (JobStore + worker pool). New `workshop/tools/jobs.py` (`get_job_status`, `list_jobs`). New `workshop/tools/_debug.py` (`_debug_sleep`, TEMPORARY — Step 8 deletes it). `workshop/tools/__init__.py` gained two static imports. `workshop/platform.py`'s long_running dispatch went from "raise OperationalError with a Step-7 breadcrumb" to real enqueue. `workshop/server.py` instantiates the JobStore once in `build_app(config)` and passes it into every Ctx.
- **JobStore threading model.** One `sqlite3.Connection` opened with `check_same_thread=False`, guarded by a `threading.RLock` on every DB op. `isolation_level=None` puts SQLite in autocommit — each statement is its own transaction, contention is trivial for this workload. A per-thread connection pool would be overengineered here. SQLite serialises writes internally anyway; the Python lock exists because `sqlite3.Connection` isn't thread-safe across concurrent operations.
- **Worker pool: `ThreadPoolExecutor(max_workers=2)`.** Two is arbitrary but bounded. Spec §5.4: "so a runaway job cannot starve the server." One tool call submits one future; the executor's own queue absorbs the rest. No hand-rolled queue.
- **Async handler → thread bridge.** In `_run_job`, `inspect.iscoroutinefunction(entry.handler)` → `asyncio.new_event_loop().run_until_complete(handler(args, ctx))`. Fresh loop per job so we don't touch the main uvicorn loop from a worker thread. Sync handlers get invoked directly. Both paths supported so a later long_running tool can be either.
- **Enqueue flow.** `ctx.jobs.enqueue(entry, args, ctx)` inserts `status='queued'`, then `executor.submit(_run_job, ...)`. Returns the `job_id` immediately. The worker: `mark_running` → invoke handler (in event loop if async) → `_validate_envelope` from platform.py → `mark_succeeded(data)` OR `mark_failed(error)`. `platform.call_tool` wraps this and returns `{"job_id": ..., "status": "queued", "poll_after_seconds": 5}` bare, per the spec's shape.
- **Ctx passed into workers is fresh, not the caller's.** The request's Ctx dies with the request; we snapshot `host_id`, `config`, `parent_log` at enqueue time and rebuild inside the worker with `jobs=self`, `job_id=<id>`, `claims={}`. `ctx.claims` is deliberately empty in the worker — jobs run without the requester's identity beyond a single "sub X enqueued job Y" log line at enqueue time. If a later step needs claim propagation, add a `claims_json` column.
- **`_validate_envelope` reused via a local import.** `platform.py` imports config (not jobs); `jobs.py` imports platform.Ctx / WorkshopError / _validate_envelope but only inside function bodies to break the load-order cycle. That keeps the module DAG clean while sharing envelope validation code — one source of truth for "did the handler return the right shape".
- **`get_job_status` and `list_jobs` are both tier 1** (spec §5.2). No confirmation required to poll or list. `list_jobs` uses `clamp_limit(args.get("limit"))` — default 20, cap 50 — same as every other list tool per spec §4.5. Optional status filter is enum-constrained in the schema to keep the surface predictable.
- **`get_job_status` for unknown id returns `{"error": "no such job", "job_id": ...}` as data, not as an exception.** A poll for an id the caller mistyped is a legitimate operational query, not a bug worth surfacing as `is_error=true`. Distinguishing "the tool couldn't run" from "the job doesn't exist" matters for the model's next move.
- **params_json excluded from public view** per spec §5.3. Only `id, tool_name, status, created_at, started_at, finished_at, result, error, progress_pct, progress_message` come back from `get_job_status` / `list_jobs`. `result_json` is parsed back to a native `result` field when the job succeeded.
- **Startup housekeeping** runs at JobStore `__init__`. Two SQL statements:
  ```sql
  -- orphan reap
  UPDATE jobs SET status='failed', finished_at=?, error='interrupted by restart'
    WHERE status='running';
  -- retention prune
  DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled')
    AND finished_at IS NOT NULL AND finished_at < ?;
  ```
  Log line reports both counts on startup. A job cannot survive the process (spec §5.4).
- **`get_workshop_status.jobs` now shows real counts.** `_jobs_snapshot(ctx)` in `tools/status.py` was already wired to delegate to `ctx.jobs.status_snapshot()` when `ctx.jobs is not None`; the JobStore method name matches, no code change to status.py.
- **`_debug_sleep` lives in `tools/_debug.py`.** Sleep is `time.sleep` (blocking); fine because it runs on a worker thread. Emits per-second progress via `ctx.jobs.update_progress(ctx.job_id, pct, msg)`. Step 8's cleanup: delete this one file + delete the `_debug` import line from `tools/__init__.py`. Two-line diff.
- **Automated smoke tests, both green.**
  1. **Full lifecycle** — enqueue `_debug_sleep(3)` via `platform.call_tool` directly (bypassing MCP + auth): got `{'job_id': '9c02a...', 'status': 'queued', 'poll_after_seconds': 5}` immediately. Polled every 0.5s; progress climbed `None → 33 → 66 → 100`; status went `running → succeeded`. Final record had `result: {"slept_seconds": 3, "job_id": "...", "host_id": "desktop"}`.
  2. **Orphan reap + retention prune** — manually inserted one row `status='running'` and one row `finished_at='2026-07-01T00:01:00Z'`. Re-instantiated JobStore. Log line: `JobStore ready (orphans_reaped=1, old_rows_pruned=1)`. First row now `status='failed', error='interrupted by restart', finished_at=<now>`. Second row: gone.
- **Registry now has 3 tools** (`get_workshop_status`, `get_job_status`, `list_jobs`, `_debug_sleep`) — wait, 4 including the temporary one. Step 8 removes `_debug_sleep` bringing it to the spec-required 3.
- **Manual verification handed off** — see the message following this section for the full script.

**Step 7 — verified end-to-end via fresh-conversation MCP calls.** `_debug_sleep(30)` returned a job_id immediately, `get_job_status` polled through `queued → running → succeeded` with progress climbing, `list_jobs` showed the run. Restart-mid-job test also worked: `_debug_sleep(60)` enqueued, Ctrl+C mid-run, restart, and the job's row read `status: failed, error: "interrupted by restart"`.

**Step 8 — Clean up**

- **`workshop/tools/_debug.py` deleted.** Single-file removal, as intended by Step 7's placement decision. Registry immediately drops to 3: `get_workshop_status`, `get_job_status`, `list_jobs`.
- **`workshop/tools/__init__.py` two-line diff.** Removed the `from . import _debug` line + the trailing "REMOVE in Step 8" comment. Now: `status` + `jobs`. No dynamic discovery, so a stray leftover import would have been a loud `ModuleNotFoundError` on next boot — not a silent survival.
- **`workshop/README.md` written.** Sections: hosts (desktop/surface split), how to run (venv + deps + .env + run.py), config (the important env keys and what they mean), layout (mirrors spec §7), how to add a tool (worked example with @define_tool + append import + tier explanation + long_running note + error taxonomy), tests, troubleshooting order. Cross-links back to `docs/technical-spec-workshop.md`, `docs/workshop-manual-setup.md`, `docs/progress-workshop.md`. Deliberately targets a future contributor writing tool #4 — not marketing, not a lore dump.
- **One unit test needed updating.** `test_long_running_not_yet_wired` from Step 2 was asserting the pre-Step-7 placeholder message contained the string "Step 7". Step 7 replaced that path with a real enqueue that only raises OperationalError when `ctx.jobs is None` (server assembly bug). Renamed to `test_long_running_without_jobstore_raises_operational` and updated the assertion to match the new (correct) message. 30/30 tests still green.
- **Local check: `get_registry()` returns exactly 3 tools**, all tier 1, all `long_running=False`. Full names + tiers verified via a one-shot script.
- **Manual verification handed off** — fresh conversation, call `get_workshop_status`, confirm `tool_count: 3` and manifest of exactly those three.

**Step 8 — verified.** Fresh-conversation manifest showed exactly 3 tools; `_debug_sleep` gone from the manifest and from the registry.

**Step 9 — MANUAL: Surface deployment.** Handed off. Follows `docs/workshop-manual-setup.md` Phase D + E. Pre-req flagged: `workshop/` is not yet in git origin — the Surface's sparse checkout would find nothing to pull. User must commit + push before Phase D.
