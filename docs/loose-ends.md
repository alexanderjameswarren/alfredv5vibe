# Loose ends

**Things that are outstanding, with the reason each one still matters.**

🛑 **THIS FILE EXISTS BECAUSE A "LOOSE ENDS" SECTION AT THE BOTTOM OF A RUNBOOK IS WHERE WORK
GOES TO STOP HAPPENING.** Every item below was, at some point, a bullet in the tail of a
document about something else. That is not a place anybody re-reads.

Each item says **what would go wrong** rather than only what is undone — an item nobody can
cost is an item nobody prioritises.

---

## OPEN — security

### 1. The Cloudflare tunnel token has not been rotated

**Status: open. Raised in the connector work of 7 September 2026, still outstanding
8 September.**

The token appeared in conversation. Creating fresh Supabase OAuth clients handled the
*secrets* half of that exposure; **the tunnel token was not part of it and is unchanged.**

⚠️ **WHAT IT ACTUALLY GRANTS, so the priority is judged rather than guessed:** a Cloudflare
tunnel token lets the holder run a connector that terminates the tunnel for
`workshop.alexanderjameswarren.com` and `workshop-dev.alexanderjameswarren.com`. **It does not
grant access to Workshop's tools** — those are gated by Supabase token validation plus
`ALLOWED_SUBS`, and a tunnel operator holds neither. The realistic harm is impersonating the
hostname or intercepting traffic to it, not calling DJ tools.

**So: real, bounded, and not urgent — which is exactly the profile of a thing that stays
undone forever.**

**To close it:** Cloudflare Zero Trust → Networks → Tunnels → the Workshop tunnel → rotate
the token, then update the connector service on each host and restart it. ⚠️ **Both hosts** —
the Surface and the desktop run separate tunnels, and rotating one leaves the other on the
old token while appearing to have worked.

**Verify with:** `.\workshop-check.ps1` — both hosts must return UP. A tunnel left on a stale
token shows as `502 - tunnel is up, server is not running`, or as no response at all.

### 2. ~~`workshop/.env.example` carried a real user ID~~ — FIXED 2026-09-08

Replaced with `00000000-0000-0000-0000-000000000000`.

⚠️ **THE REAL ID REMAINS IN GIT HISTORY.** Replacing the file stops it propagating forward;
it does not undo the exposure. Rewriting history for this is not proportionate — see below.

**Why it was worth fixing anyway, and why it is not an emergency:** a Supabase user id is
**not a credential** and cannot authenticate anything on its own. But it is the exact value
`ALLOWED_SUBS` compares against, so it tells an attacker which `sub` to aim for if a
token-signing weakness ever appeared. The real defence is that tokens are signature-verified
against Supabase's JWKS; the id is the target, not the key.

⚠️ **A TEMPLATE THAT SHIPS A LIVE VALUE GETS COPIED FORWARD FOREVER**, which is the part that
justified the change on its own. The placeholder **fails closed** — an unedited copy denies
every tool call, which is the right way for a template to be wrong.

---

## OPEN — not security

### 3. `music21` is not installed on the desktop host

**Blocks the SAM simplification pipeline.** `get_workshop_status` reports
`music21.available: false` on the desktop, which is the check that will confirm the fix.

**To close it:** install into the desktop host's venv
(`.\.venv\Scripts\python.exe -m pip install music21`), restart Workshop, confirm via
`get_workshop_status`.

### 4. The tag cleanup pass has not been run

**Blocks stage 2 of the Jazz thread**, and only stage 2 — see spec §14.35.

The `jazz` artist tags were seeded from playlist membership, so they include anyone appearing
on a track in *Christmas jazz*. **`B.J. Thomas` is tagged jazz.** He is a real artist wrongly
labelled, which is worse than an obvious junk string (`Anything_F_744`, `aron!`, `Dec 29,
2023`) because **it looks correct** — *"go deeper on artists you love"* would recommend him
with a straight face.

**To close it:** `get_dj_artist_tags mode=review` orders by how little evidence exists that a
string names an act, weakest first. Work down it. ⚠️ **Not inside a weekly review** — an
irreversible judgement about ~91 rows does not belong in a conversation about concerts.

### 5. `unremovable_entries` in `replace_dj_playlist` is unexercised

**Not a bug — an untested branch, recorded as such (spec §14.42).**

It needs a playlist entry with no `setVideoId`, which a clean playlist cannot produce. Unit
tested against a fake; never run against YouTube. ⚠️ **Recorded as untested rather than
counted as working**, because the difference is the whole of §11.16.

---

## Closed

| item | closed | how |
|---|---|---|
| Supabase OAuth clients recreated as confidential with secrets | 2026-09-07 | see `runbook-mcp-connectors.md` |
| `.env.example` real user id | 2026-09-08 | placeholder that fails closed |
| Credential liveness unprovable (`credential_readable` only proved the file existed) | 2026-09-08 | `/credential` probe + `workshop-check.ps1` |
