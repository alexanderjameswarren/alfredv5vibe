# MCP Connector Setup — Alfred, Workshop (Surface), Workshop (Dev)

**Last verified: 7 September 2026.** Folded into the repo 8 September 2026.

🛑 **THIS SUPERSEDES `technical-spec-dj.md` §9's "Reconnecting the Alfred MCP connector".**
That section says **public client, blank secret**, and names a specific client id. It is
**wrong**, and following it produces `400: Invalid client credentials` at the token endpoint.
The spec now points here and keeps the old values only so they can be recognised as the
wrong ones — see *"The superseded procedure"* at the bottom, which matters if you have them
written down anywhere else.

---

## Why this document exists

All three connectors broke at once. Claude used to register itself with the authorization
server automatically, using Dynamic Client Registration. That path no longer works with
Supabase, so every connector now needs an OAuth client that you create by hand, once, in the
Supabase dashboard.

If you are reading this because a connector has stopped working, skip to **Troubleshooting**.

---

## How the pieces fit together

Two separate concerns, easy to confuse.

**Transport** — how a request physically reaches the server.

- Alfred runs as a Supabase Edge Function, reachable directly over the internet.
- Workshop runs as a Python server on your own machines. Cloudflare tunnels carry requests
  from the internet to the Surface tablet and to the desktop, because neither has a public
  IP address.

**Authorization** — who decides that you are you.

- Supabase Auth is the authorization server for *all three* connectors, including both
  Workshop hosts. Workshop's `ALLOWED_SUBS` check compares the `sub` claim against your
  Supabase user ID, so it has to be Supabase that issues the token.

**Cloudflare carries traffic. Supabase issues identity. They are unrelated jobs.**

---

## Connector reference

| Connector | MCP URL | Supabase OAuth app |
|---|---|---|
| Alfred | `https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/mcp` | `Claude` |
| Workshop (Surface) | `https://workshop.alexanderjameswarren.com/mcp` | `Workshop (Surface)` |
| Workshop (Dev) | `https://workshop-dev.alexanderjameswarren.com/mcp` | `Workshop (Dev)` |

Each connector gets its **own** OAuth app. They could share one, but separate apps mean you
can revoke or rotate one without breaking the others.

⚠️ **Client IDs and secrets are deliberately not recorded here.** The client ID is visible any
time in the Supabase dashboard; the secret is shown only once at creation and can be
regenerated if lost. A runbook that carries credentials becomes a credential.

---

## Supabase OAuth app settings

Authentication → OAuth Apps → New OAuth App.

| Field | Value |
|---|---|
| Name | Match the connector name |
| Redirect URI | `https://claude.ai/api/mcp/auth_callback` |
| Public Client | **Off (confidential)** |
| Token Endpoint Auth Method | **Request body (`client_secret_post`)** |

Two things that will bite you:

- The redirect URI must match **exactly** — no trailing slash, no variation. Supabase does
  not support wildcards or partial URLs for OAuth client redirect URIs, unlike the general
  Redirect URLs setting where `/**` works.
- **Copy the client secret the moment it appears.** It is masked afterwards and can only be
  regenerated, not recovered.

`client_secret_post` sends the secret in the request body. The Supabase default is
`client_secret_basic`, which sends it in an HTTP header. Claude's token requests are
form-encoded, and the successful connections were all made with `client_secret_post`.

---

## Adding a connector in Claude

1. Settings → Connectors. If the connector already exists, **Remove** it — do not just
   disconnect. A stale client registration is part of what you are clearing.
2. Add custom connector.
3. Paste the MCP URL from the table above. No trailing slash.
4. Open **Advanced settings** and paste the client ID and client secret.
5. Connect. You will be sent to Alfred's consent screen at
   `alfredv5vibe.vercel.app/oauth/consent`.
6. Approve.
7. **Start a new conversation.** The tool list is frozen when a conversation begins, so the
   thread you were in cannot see the reconnected server.

---

## What each server must provide

You should not need to change these — they are already correct — but this is what makes the
flow work, so it is what to check if someone edits it.

**A 401 on unauthenticated tool calls**, carrying a `WWW-Authenticate` header pointing at the
metadata document:

```
WWW-Authenticate: Bearer error="invalid_token",
  error_description="Authentication required",
  resource_metadata="https://<host>/.well-known/oauth-protected-resource"
```

**A protected resource metadata document** at that URL:

```json
{
  "resource": "https://<host>/functions/v1/mcp",
  "authorization_servers": ["https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": []
}
```

The `resource` field must include the full path to the MCP endpoint. Workshop was serving the
bare origin without `/mcp` and that had to be fixed. The metadata URL itself does not have to
sit on the server's own origin, which matters for Alfred because Supabase Edge Functions
cannot serve `/.well-known/*` at the project root — Alfred serves it under the function path.

**Token validation** checks the signature against
`https://zuqjyfqnvhddnchhpbcz.supabase.co/auth/v1/.well-known/jwks.json`, the issuer, expiry,
and that the audience is the literal string `authenticated`.

🛑 **Do NOT check that the audience equals the MCP URL.** Supabase does not implement the RFC
8707 `resource` parameter, and every Supabase access token carries `aud: "authenticated"`
regardless of which client requested it. The real per-user boundary is `ALLOWED_SUBS` on
Workshop and row level security on Alfred.

---

## Deploying changes

Three different mechanisms, easy to conflate:

| Component | How to deploy |
|---|---|
| Alfred frontend (React) | `git push`, Vercel builds |
| Alfred MCP (Edge Function) | `supabase functions deploy mcp` |
| Workshop (Python) | `git push`, then refresh on each host |

Workshop runs on two machines and both need updating. On the Surface, use the Refresh
Workshop shortcut on the tablet. On the desktop, use Start Workshop Dev. **Confirm the
refresh actually pulled** — a restart without a pull leaves the old code running and looks
like the fix failed.

⚠️ **After deploying the Alfred Edge Function, re-check that JWT verification is still
disabled.** Supabase can silently re-enable it on redeploy, and its gateway then rejects
Claude's tokens before your code ever runs. Make it durable in `supabase/config.toml`:

```toml
[functions.mcp]
verify_jwt = false
```

*(The deploy command in this repo's memory is `npx supabase functions deploy mcp
--no-verify-jwt`. The `config.toml` entry is the durable form of the same thing — prefer it,
because a flag has to be remembered on every deploy and a config file does not.)*

`ALLOWED_SUBS` lives in `workshop/.env` on each host and is read at process start. **Editing
it does nothing until the process restarts.**

---

## Verification

Run these after any change. Each should return the URL with the correct path.

```bash
curl -s https://workshop.alexanderjameswarren.com/.well-known/oauth-protected-resource
curl -s https://workshop-dev.alexanderjameswarren.com/.well-known/oauth-protected-resource
curl -s https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource
```

Confirm an unauthenticated call is refused properly:

```bash
curl -i -X POST https://<host>/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expect `401` and a `WWW-Authenticate` header. If you get a Supabase gateway error about a
missing authorization header instead, JWT verification is switched on and your code never ran.

Watch the flow in Supabase → Logs → Auth logs. A healthy connection looks like:

```
GET  /oauth/authorize                     302
GET  /user                                200
GET  /oauth/authorizations/{id}           200
POST /oauth/authorizations/{id}/consent   200
POST /oauth/token                         200
```

🛑 **THEN TEST AGAIN AFTER AN HOUR.** Access tokens last 3600 seconds. **A successful
connection proves nothing about renewal, and renewal is what failed originally.** See the
next section — this is not a precaution, it is the actual test.

---

## 🛑 The failure this document was written after — and how to recognise it

`technical-spec-dj.md` §14.29-adjacent debugging chased a persistent 401 for two weeks at the
wrong layer. The Supabase auth log showed:

```
10:47:42  POST /auth/v1/oauth/token   200   <- fresh token issued
10:50:11  POST /auth/v1/oauth/token   400   <- refresh REJECTED
10:50:15  POST /rest/v1/rpc/...       401
```

**The Edge Function was never the problem.** It reads the Authorization header per request
and forwards that exact token to PostgREST — it mints, caches and refreshes nothing. A 401
there means the token arrived already expired, **which is a statement about the client's
refresh, not about the server.**

⚠️ **THIS DOCUMENT'S TROUBLESHOOTING TABLE EXPLAINS THAT 400:** *"`400: Invalid client
credentials` at `/oauth/token` — wrong or missing client secret, or a Token Endpoint Auth
Method mismatch."* A public client with a blank secret is exactly that condition.

⚠️ **AND IT EXPLAINS WHY THE FIRST EXCHANGE SUCCEEDED WHILE THE REFRESH FAILED** — the
detail that made it look like a server fault. A PKCE authorization-code exchange can succeed
without client authentication; **the refresh grant requires it.** So the connection worked
for exactly one access-token lifetime and then died, every time, which reads as "it works
then breaks" rather than "the client cannot authenticate".

🛑 **STATED AS THE MOST LIKELY EXPLANATION, NOT AS PROVEN.** The body of that 400 was never
captured. It is consistent with every observation and with this document's own table, and no
other cause was found — but if it recurs, **capture the 400's response body first**; it
distinguishes `invalid_client` from `invalid_grant` in one line and would have saved a
fortnight.

**The lasting fix is the one at the top of this document: confidential clients, real secrets,
`client_secret_post`.** The lasting *test* is the one-hour recheck.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Automatic client registration isn't supported" | No OAuth app exists for that connector. Create one. |
| `400: Invalid client credentials` at `/oauth/token` | Wrong or missing client secret, or a Token Endpoint Auth Method mismatch. |
| `error_code=mcp_token_exchange_failed` in a Claude URL | Same as above. Consent succeeded, the token exchange did not. |
| `authorization request is no longer pending` | The authorization ID was already resolved. Delete and recreate the OAuth app, which clears existing grants. |
| Connector adds and shows tools with no login prompt | Suspect. The auth gate may not be firing, or a previous grant is still live. |
| Connects fine, every tool call denied | Workshop: `ALLOWED_SUBS` mismatch, or the process is running an older copy of `.env`. Restart it. |
| Worked, then failed about an hour later | Token renewal. Check the auth log for a `POST /oauth/token` with `grant_type=refresh_token`. **See the section above.** |
| New tools do not appear | The tool list freezes at conversation start. Start a new conversation. |

Claude caches OAuth discovery documents globally by URL for roughly five minutes, so allow
for that after changing a metadata document.

When a connection fails, Claude shows a reference code beginning `ofid_`. **Copy it
immediately** — these are time-limited, and it is what Anthropic support needs.

---

## The superseded procedure

Kept so it can be **recognised as wrong**, not followed. Deleting it would leave the values
alive wherever else they are written down, with nothing to contradict them.

`technical-spec-dj.md` §9 said to use *"Use your own OAuth client"* with a named client id and
a **blank** client secret, describing it as *"a public client already registered with Claude's
redirect URI"*.

🛑 **Every connector is now a CONFIDENTIAL client with a real secret and
`client_secret_post`.** A blank secret is the `400: Invalid client credentials` case in the
table above, and it is the most likely cause of the two-week 401.

---

## Loose ends

🛑 **SECURITY — the two below are tracked in `docs/loose-ends.md` rather than only here.**
Items filed in a runbook's tail stay outstanding forever.

- **The Cloudflare tunnel token is still unrotated** after appearing in conversation.
  Creating fresh OAuth clients handled the secrets half of that; the tunnel token is
  outstanding. **Open.**
- ~~`workshop/.env.example` contains a real user ID rather than a placeholder.~~ **Fixed
  2026-09-08** — replaced with an all-zero placeholder that fails closed. ⚠️ The real id
  remains in git history; replacing the file stops it propagating forward but does not undo
  the exposure. A Supabase user id is not a credential and cannot authenticate anything on
  its own, but it is the exact value `ALLOWED_SUBS` gates on.
- `music21` is still not installed on the desktop host, which blocks the SAM simplification
  pipeline. **Open, not security.**
