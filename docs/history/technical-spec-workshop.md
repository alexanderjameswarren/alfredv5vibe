# Technical Spec — Workshop

**What it is:** a local MCP server, installed as a Windows service, exposed through a
Cloudflare tunnel and registered as a custom connector. It runs work that Supabase
Edge Functions cannot: LAN-bound devices, local-auth-bound APIs, heavy Python
libraries, and long-running compute.

**Location:** `workshop/` inside the `alfred-v5` repo.
**This increment:** auth, the platform module, `get_workshop_status`, async job
scaffolding, two-host deployment. **No music21, no domain tools.** Hello world plus
the foundation everything else stands on.

---

## 1. Naming and vocabulary

Workshop is a **place**, not a persona. Alfred, SAM, Warren, Homer are apps that own
domains of life; Workshop is infrastructure they reach into for specialised tools.
It is a *server* (it listens and answers), installed as a *service* (Windows manages
its lifecycle). "Daemon" and "runner" are not used.

Because it is a place, it can move. If the Surface proves too flaky, the same code on
a cloud VM is still Workshop — only the address changed.

---

## 2. Hosts

| Host | Hostname | Role | `WORKSHOP_HOST_ID` |
|---|---|---|---|
| Desktop | `workshop-dev.alexanderjameswarren.com` | staging — iterate here | `desktop` |
| Surface | `workshop.alexanderjameswarren.com` | production — LAN-resident | `surface` |

Both registered as separate connectors. The Surface only ever runs code that already
worked on the desktop. This is what makes "enhance without breaking" cheap rather
than careful.

---

## 3. Authentication

### 3.1 What was ruled out and why

- **Cloudflare Access service tokens** — require `CF-Access-Client-Id` /
  `CF-Access-Client-Secret`. Claude.ai restricts connector request headers to an
  allowlist of standard names (`authorization`, `x-api-key`, `x-auth-token`), and
  additions require an Anthropic representative. Dead.
- **Static bearer token** — would work, but the Request headers feature is in beta
  and is not present in this account's connector dialog. Dead for now.
- **Workshop as its own OAuth authorization server** — several hundred lines of
  security-critical Python running on a tablet. Unnecessary, see below.

### 3.2 What we do instead

**Supabase is already a full OAuth 2.1 authorization server.** Verified live:

```
issuer                        https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1
authorization_endpoint        .../auth/v1/oauth/authorize
token_endpoint                .../auth/v1/oauth/token
jwks_uri                      .../auth/v1/.well-known/jwks.json
registration_endpoint         .../auth/v1/oauth/clients/register     ← DCR works
code_challenge_methods        S256, plain
jwks                          one ES256 key (asymmetric)
```

Metadata is served at **`/auth/v1/.well-known/oauth-authorization-server`**, not at
the domain root — the root path 404s. The protected-resource document must point at
the `/auth/v1` issuer.

**Workshop is a resource server only.** It issues nothing, stores no credentials, and
holds no shared secret — ES256 means it verifies with a public key. `registration_endpoint`
being present means Claude registers itself dynamically, so the connector's OAuth
Client ID and Secret fields stay **empty**.

### 3.3 What Workshop must implement

**Protected resource metadata** at `/.well-known/oauth-protected-resource`:

```json
{
  "resource": "https://workshop-dev.alexanderjameswarren.com",
  "authorization_servers": ["https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["openid", "email"]
}
```

`resource` must exactly match the server's public origin, so it is derived from
config per host, never hardcoded.

**401 challenge** on any unauthenticated `/mcp` request:

```
WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
```

This header is what starts discovery. Without it the client has no idea where to go.
Serve the metadata document at the path-suffixed variant too
(`/.well-known/oauth-protected-resource/mcp`) — clients probe both.

**Token verification** — use `PyJWKClient` from PyJWT, which handles JWKS fetch, `kid`
lookup, and caching. Cache with a TTL and refetch on unknown `kid`, or key rotation
takes Workshop down at an inconvenient moment.

> Check whether the installed MCP Python SDK provides built-in resource-server auth
> (a `TokenVerifier` / `AuthSettings` surface). If it does, prefer it over
> hand-rolling — the required *behaviour* is specified above either way. I could not
> verify the current API from here; read the installed package.

### 3.4 Two-pass rollout — do not skip pass 1

Nobody can write the final validator before seeing a real token.

**Pass 1 — `WORKSHOP_AUTH_MODE=permissive`.** Verify the ES256 signature and `exp`.
Then **log the full decoded claims** and accept. Register the connector, call a tool,
read the log. Specifically capture: what is in `aud`, is there a `resource` claim, is
there an `azp` or client id, what is `sub`, what is the `exp` lifetime.

**Pass 2 — `WORKSHOP_AUTH_MODE=strict`.** Enforce exactly what was observed, plus:

```python
ALLOWED_SUBS = {"26f0707f-b586-4a3e-841c-8c313d6ab1e5"}
```

**Why the `sub` allowlist is not optional.** Supabase's metadata does not advertise
`resource_indicators_supported`, and Supabase JWTs have historically carried a
constant `aud` of `"authenticated"`. If the `resource` parameter is ignored, *any*
token from this Supabase project is valid at Workshop — including tokens sitting in
browser storage for Alfred's React app. The `sub` check reduces that to "a stolen
token of yours" rather than "anyone with an account on this project." A stolen Alfred
token still works; that is an accepted, documented risk for a single-user system.

Pass 1 is a **temporary state**. The tunnel hostname stays unpublished until pass 2
lands, and permissive mode is never the resting configuration on the Surface.

### 3.5 `/health` is deliberately unauthenticated

Returns host id, version, git sha, uptime, tool count. Nothing sensitive. It exists so
that troubleshooting works before auth is in play — otherwise "is it running?" and
"is auth right?" become one indistinguishable question.

---

## 4. The platform module

`workshop/platform.py` — the Python mirror of `_shared/platform.ts`. Same taxonomy,
same envelope discipline, same error classes. **Do not invent a second architecture.**

### 4.1 `define_tool`

```python
@define_tool(
    name="get_workshop_status",
    tier=1,
    description="...",
    input_schema={"type": "object", "properties": {}},
    long_running=False,
)
async def get_workshop_status(args: dict, ctx: Ctx) -> dict:
    ...
```

Responsibilities, all of them mechanical rather than aspirational:

- **Tier gating.** Tier 3 intercepts calls lacking `args["confirmed"] is True` and
  returns a proposal object instead of executing. Never roll a bespoke confirmation.
- **Registration.** Every tool lands in a module-level registry, which is what
  `get_workshop_status` reports and what the MCP `list_tools` handler serves.
- **Schema parity.** Every key the handler reads must appear in `input_schema`. An
  honoured-but-unadvertised parameter is invisible to any fresh session, because the
  manifest freezes at conversation start.
- **Envelope.** Handlers return `{data, meta}` internally; the MCP layer emits
  `data` **bare**. When `meta.truncated`, prepend
  `NOTE: results truncated to N of M. Narrow the query or request a specific subset.`
  That is the one fact the model cannot infer — a clamped result looks identical to a
  complete one.
- **Long-running dispatch.** `long_running=True` enqueues a job and returns a handle
  instead of executing inline.

### 4.2 Tiers

Identical to the TypeScript contract. Tier is a property of the **tool**, never of the
situation — a situational tier is unreadable from the manifest.

| Tier | Meaning |
|---|---|
| 1 | Reads, appends to append-only stores, own-state updates. No gate. |
| 2 | Updates to existing rows. Audited. |
| 3 | Destructive, superseding, or semantically significant. Human confirms. |

### 4.3 Errors — two classes, deliberately worded differently

- **Guardrail denials** (budget, loop) carry terminal wording verbatim:
  `"LOOP DETECTED... Do NOT retry — retrying will not change the result. Stop and
  report to the user."` Never soften or paraphrase.
- **Operational failures** (timeout, network, subprocess crash) are legitimately
  retryable and must **NOT** carry do-not-retry wording. Stamping "do not retry" on a
  transient error suppresses a retry that should happen.

Set MCP `isError: true` *and* put the message in the text verbatim; clients format the
flag inconsistently.

### 4.4 `Ctx`

What a handler receives. Tools reach for nothing global — the Workshop analogue of
"never import the Supabase client in a tool file."

```python
@dataclass
class Ctx:
    host_id: str
    config: Config          # values, never logged
    jobs: JobStore
    log: Logger
    claims: dict            # decoded token, observability only
    job_id: str | None      # set when running inside a job
```

### 4.5 `clamp_limit`

`clamp_limit(requested, default=20, cap=50)`. No list tool returns unbounded rows.

---

## 5. Async jobs

### 5.1 Why now

MCP tool calls are request/response with a client-side timeout. Three of the five
planned capabilities blow past it: demucs stem extraction (minutes, GPU-hungry),
Audiveris OMR, and batch score transforms. Retrofitting async into a synchronous tool
layer after ten tools exist is miserable; adding it while the module is four files is
nearly free.

### 5.2 Design — no generic dispatcher

A generic `start_job(tool_name, args)` would make the effective tier depend on which
tool was wrapped, which is exactly the situational tier we ruled out. Instead:

- A long tool declares `long_running=True` in its own `define_tool`, keeps its own
  tier, and appears in the manifest under its own name. Calling it enqueues and
  returns `{job_id, status, poll_after_seconds}`.
- One generic tool, **`get_job_status`** (tier 1), polls.
- One generic tool, **`list_jobs`** (tier 1), lists recent jobs with a clamped limit.

Nothing in this increment sets `long_running=True`. The scaffolding is built and
tested with a deliberate `_debug_sleep` tool, then that tool is removed.

### 5.3 Storage — SQLite, local

Jobs are **host-local and ephemeral**. They do not belong in Supabase: that would mean
a new registered table, a migration, and Supabase write credentials on a tablet, all
to track work that only matters on the machine that ran it. `data/workshop.db`,
gitignored.

```sql
create table if not exists jobs (
  id               text primary key,
  tool_name        text not null,
  status           text not null,      -- queued|running|succeeded|failed|cancelled
  created_at       text not null,
  started_at       text,
  finished_at      text,
  params_json      text,
  result_json      text,
  error            text,
  progress_pct     integer,
  progress_message text
);
```

`get_job_status` returns everything except `params_json`, plus the parsed result when
finished.

### 5.4 Execution

A bounded worker pool (`ThreadPoolExecutor`, 2 workers) so a runaway job cannot starve
the server. On startup, any job left `running` from a previous process is marked
`failed` with "interrupted by restart" — a job cannot survive the process, and
silently leaving it "running" forever is a lie.

Retention: delete jobs finished more than 7 days ago, on startup.

---

## 6. `get_workshop_status`

The first tool, built **through** the decorator so hello world and foundation are the
same artifact. Returns:

```json
{
  "host": "desktop",
  "version": "0.1.0",
  "git_sha": "a1b2c3d",
  "started_at": "2026-07-30T14:02:11Z",
  "uptime_seconds": 3600,
  "auth_mode": "strict",
  "dependencies": {
    "music21":    { "available": false, "version": null },
    "ytmusicapi": { "available": false, "version": null, "auth_valid": null }
  },
  "tools": [ { "name": "get_workshop_status", "tier": 1, "long_running": false } ],
  "config_keys_present": ["SUPABASE_ISSUER", "ALLOWED_SUBS", "WORKSHOP_PORT"],
  "jobs": { "queued": 0, "running": 0, "finished_24h": 0 }
}
```

**`config_keys_present` lists key names only, never values.** Host identity earns its
place the moment two connectors are registered and you need to know which answered.
The dependency probe is how you learn ytmusicapi auth expired on your schedule rather
than mid-request.

This is Workshop's answer to `check_platform_conformance`.

---

## 7. Layout

```
workshop/
  run.py                    entrypoint (uvicorn)
  requirements.txt
  .env.example              committed; .env is NOT
  .gitignore                .env, data/, .venv/
  README.md
  workshop/
    __init__.py
    config.py               env loading, host identity, origin derivation
    platform.py             define_tool, Ctx, tiers, errors, clamp_limit, envelope
    auth.py                 JWKS verify, metadata docs, 401 challenge
    jobs.py                 SQLite store, worker pool
    server.py               Starlette app, MCP mount, /health, /.well-known
    tools/
      __init__.py           imports every tool module so decorators run
      status.py             get_workshop_status
      jobs.py               get_job_status, list_jobs
  data/                     gitignored — workshop.db, workshop.log
```

### Dependencies

`mcp`, `uvicorn`, `starlette`, `pyjwt[crypto]`, `httpx`, `python-dotenv`.
Pin versions in `requirements.txt` — the Surface installs from it unattended.

### Config (`.env`, per host, never committed)

```
WORKSHOP_HOST_ID=desktop
WORKSHOP_PORT=7777
WORKSHOP_PUBLIC_ORIGIN=https://workshop-dev.alexanderjameswarren.com
WORKSHOP_AUTH_MODE=strict
SUPABASE_ISSUER=https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1
ALLOWED_SUBS=26f0707f-b586-4a3e-841c-8c313d6ab1e5
```

`.env` lives only on the machine, so `git reset --hard` never touches it. That is what
makes the refresh button safe.

---

## 8. Implementation sequence

| # | Step | Gate |
|---|---|---|
| 0 | Manual: Python on desktop | `python --version` ≥ 3.11 |
| 1 | Scaffold, config, `/health`, uvicorn | `curl 127.0.0.1:7777/health` returns JSON |
| 2 | `platform.py` — decorator, registry, tiers, errors, envelope | Unit test: tier-3 without `confirmed` returns a proposal |
| 3 | MCP mount + `get_workshop_status` | MCP Inspector lists and calls it locally |
| 4 | Manual: Cloudflare tunnel (Phase B) | `https://workshop-dev.../health` responds |
| 5 | Auth — metadata, 401, JWKS, **permissive** | Manual: register connector (Phase C), sign in |
| 6 | Read logged claims; write pass-2 validation; flip to strict | Tool call still succeeds; a tampered token 401s |
| 7 | Jobs — SQLite, worker pool, `get_job_status`, `list_jobs`, `_debug_sleep` | Enqueue a 30s sleep, poll to `succeeded`, restart mid-job → `failed` |
| 8 | Remove `_debug_sleep`; README | Manifest is 3 tools |
| 9 | Manual: Surface deployment (Phase D + E) | Refresh button green; both connectors answer with correct `host` |

Steps 4, 5's registration, and 9 are **manual** and gated on human confirmation.

Step 5 requires a **fresh conversation** to be callable — the MCP manifest freezes at
conversation start, and the settings-panel tool count is the reliable deployment
confirmation.

---

## 9. Success criteria

- `/health` answers on both hostnames without a token.
- `/mcp` without a token returns 401 carrying `WWW-Authenticate` with
  `resource_metadata`.
- Adding the connector with **blank** OAuth fields completes via DCR against Supabase.
- A token signed by a different key is rejected.
- A valid token with a `sub` outside `ALLOWED_SUBS` is rejected.
- `get_workshop_status` returns `host: desktop` from one connector and
  `host: surface` from the other.
- A long job survives polling; a job interrupted by restart reports `failed`, not
  `running`.
- Restarting Workshop does not disturb the tunnel or require re-authentication.
- The refresh button on the Surface pulls, restarts, and reports health in one tap.

---

## 10. Deliberately out of scope

music21 and score analysis; ytmusicapi and DJ; Bambu MQTT; Home Assistant; Warren;
Homer; the `sam-scores` Storage bucket and `source_xml_path`; the `/control` web page.

Every one of those is additive once the platform module exists. Adding the fifteenth
tool should cost what the second one cost — that is the entire point of building this
foundation before any capability.
