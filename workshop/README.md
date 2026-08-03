# Workshop

A local MCP server that runs work Supabase Edge Functions can't: LAN-bound
devices, local-auth-bound APIs, heavy Python libraries, and long-running
compute. Installed as a Windows service, exposed through a Cloudflare tunnel,
registered as a custom MCP connector in Claude.ai.

**Workshop is a place, not a persona.** Alfred, SAM, Warren, Homer own domains
of life; Workshop is infrastructure they reach into for specialised tools.

- Full technical spec: [`../docs/technical-spec-workshop.md`](../docs/technical-spec-workshop.md)
- Manual (human) setup steps: [`../docs/workshop-manual-setup.md`](../docs/workshop-manual-setup.md)
- CLI progress log: [`../docs/progress-workshop.md`](../docs/progress-workshop.md)

## Hosts

| Role | Hostname | `WORKSHOP_HOST_ID` |
|---|---|---|
| Desktop (staging — iterate here) | `workshop-dev.alexanderjameswarren.com` | `desktop` |
| Surface (production — LAN-resident) | `workshop.alexanderjameswarren.com` | `surface` |

Same code both places. `get_workshop_status` tells you which one answered.

## Run it

```powershell
cd C:\Users\Alex\projects\alfred-v5\workshop
python -m venv .venv                              # first time only
.\.venv\Scripts\pip install -r requirements.txt   # first time / after refresh
copy .env.example .env                            # first time; edit values
.\.venv\Scripts\python.exe run.py
```

Then in another window:

```powershell
Invoke-RestMethod http://127.0.0.1:7777/health
```

Returns host id, version, git sha, uptime, and tool count. `/health` is
deliberately unauthenticated (spec §3.5) so troubleshooting works before auth
is in play.

## Config

Every value has an env key documented in `.env.example`. `.env` is per-host,
gitignored, and lives only on the machine — that's what makes
`git reset --hard` a safe operation on the Surface (the refresh button).

The important ones:

- `WORKSHOP_HOST_ID` — `desktop` or `surface`. Returned by `/health` and
  `get_workshop_status`.
- `WORKSHOP_PUBLIC_ORIGIN` — the tunnel's public URL. `resource` in the
  protected-resource metadata derives from this, so it must match the
  connector's server URL exactly.
- `WORKSHOP_AUTH_MODE` — `strict` (the resting configuration) or
  `permissive` (temporary claims-discovery mode; never leave on).
- `ALLOWED_SUBS` — comma-separated Supabase user IDs allowed to call tools.
  The real single-user boundary. See spec §3.4 for the threat model.

## Layout

```
workshop/
  run.py                    entrypoint (uvicorn)
  requirements.txt          pinned; the Surface installs unattended
  .env.example              committed; .env is gitignored
  workshop/
    __init__.py             version, git_sha, uptime helpers
    config.py               env loading + Config dataclass
    platform.py             @define_tool, Ctx, tiers, errors, envelope, clamp_limit
    auth.py                 SupabaseTokenVerifier (MCP SDK TokenVerifier)
    jobs.py                 SQLite JobStore + ThreadPoolExecutor
    server.py               Starlette app, MCP mount, /health, /.well-known/*
    tools/
      __init__.py           imports every tool module so decorators run
      status.py             get_workshop_status
      jobs.py               get_job_status, list_jobs
  data/                     gitignored: workshop.db, workshop.log
  tests/                    stdlib unittest — no pytest dep on the Surface
```

## Adding a tool

1. Write a module under `workshop/workshop/tools/`. Use `@define_tool` and
   return an `{data, meta}` envelope:

   ```python
   from ..platform import Ctx, define_tool

   @define_tool(
       name="my_new_tool",
       tier=1,
       description="What it does. Written for the model to read at manifest time.",
       input_schema={
           "type": "object",
           "properties": {
               "target_id": {"type": "string"},
           },
           "required": ["target_id"],
       },
   )
   async def my_new_tool(args: dict, ctx: Ctx) -> dict:
       # Every key you read from `args` MUST appear in `input_schema.properties`
       # or registration fails (schema-parity check runs at import).
       result = do_the_thing(args["target_id"])
       return {"data": result}
   ```

2. Append the import to `workshop/workshop/tools/__init__.py`:

   ```python
   from . import my_new_tool  # noqa: F401
   ```

   No dynamic discovery — a missing import is an import-time error rather
   than a silently-absent tool.

3. Restart Workshop; the manifest picks it up on the next fresh MCP session.
   The client-side connector caches the manifest per conversation, so you
   need a fresh Claude conversation to see it in the tools list.

### Tiers

Property of the tool, never of the situation (spec §4.2).

| Tier | Meaning | Gate |
|---|---|---|
| 1 | Reads, appends to append-only stores, own-state updates | none |
| 2 | Updates to existing rows | audited |
| 3 | Destructive, superseding, or semantically significant | requires `args["confirmed"] is True`, else returns a proposal |

### Long-running tools

Set `long_running=True` on `@define_tool`. Calling such a tool enqueues a job
and returns `{job_id, status: "queued", poll_after_seconds}` immediately.
The handler runs on a `ThreadPoolExecutor(max_workers=2)` worker; poll via
`get_job_status`. Handlers can report progress with
`ctx.jobs.update_progress(ctx.job_id, pct, message)`.

### Errors

- `GuardrailError(reason)` — terminal denial. Auto-appends the
  `Do NOT retry — retrying will not change the result. Stop and report to
  the user.` clause. Use for budget cap, loop detection, hard refusal.
- `OperationalError(message)` — retryable failure (timeout, network,
  subprocess crash). Refuses do-not-retry wording at construction to prevent
  suppressing a retry that should happen.

## Tests

```powershell
cd C:\Users\Alex\projects\alfred-v5\workshop
.\.venv\Scripts\python.exe -m unittest discover -v tests
```

Stdlib unittest — no dev-dep on the Surface. Covers the platform module
(tier gating, schema parity, error taxonomy, envelope, clamp_limit).

## Troubleshooting

When something is wrong, work outside-in (per manual-setup Phase E):

1. `Get-Service cloudflared` — is the tunnel process alive?
2. `Invoke-RestMethod http://127.0.0.1:7777/health` — is Workshop alive locally?
3. `Invoke-RestMethod https://<public-hostname>/health` — does the tunnel reach it?
4. `Get-Content data\workshop.log -Tail 50` — what did it say?
