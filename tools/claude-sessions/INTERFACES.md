# Switchboard interfaces (draft, switchboard2-h8r 0.8)

Every place one piece hands data to another. Phase 3 moves pieces apart; each row
here must keep working, or change on both sides at once. Spec §4.

**Version checks:** none exists today. A row with "none" relies on both sides
coming from the same commit. Spec §4 gives each interface a version string
before the move, so a mismatch is refused rather than guessed at.

## Inside the machine

| # | Interface | Direction | File or channel | Version check |
|---|---|---|---|---|
| 1 | Session status | hooks (`prompt-check.mjs`, `session-status.mjs`) → panel | `<checkout>/.clip/session-status.json`, format in `scripts/lib/session-status.mjs`; read by `ReadStatus` in `claude-sessions.ahk` | none |
| 2 | Last report | `clip.mjs` → panel | `<checkout>/.clip/last-report.json` (`run_tag`, `title`, `pushed_at`), `scripts/lib/last-report.mjs`; read by `ReadReportMeta` | none |
| 3 | Step scope | prompt hook → plan guard, `clip.mjs --scope` | `<checkout>/.clip/scope.json` (`run_tag`, `found`, `scope`, `estimate`), `scripts/lib/plan-scope.mjs` | none |
| 4 | Guard log | claims guard, plan guard, prompt hook → `clip.mjs --scope` | `<checkout>/.clip/claims-guard.log`; `--scope` parses `ALLOW … plan <tag>  in scope: <path>` | none; a format change breaks `touchedFromLog` |
| 5 | Claims | `claims.mjs`, guards, git commands ↔ each other; → panel | `<git common dir>/alfred-claims.json`, written only through `scripts/lib/claims-core.mjs` under its lock | none |
| 6 | Claim blocks | claims guard → block-notice hook, panel | `<git common dir>/alfred-claim-blocks.json` | none |
| 7 | Main's binding | prompt hook, `claims.mjs bind`, gitpush Finish → panel, prompt hook | `<git common dir>/alfred-project-code.json` (`code`) | none |
| 8 | Migration numbers | `claims.mjs number-migration` | `<git common dir>/alfred-migration-numbers.json` | none |
| 9 | Live worktrees | git → prompt hook, panel | `<git common dir>/worktrees/*/gitdir`, `.claude/worktrees/*/.git` | git's own layout |
| 10 | Overwatch outbox | claims, guard, gitpush → `scripts/overwatch-post.mjs` | `<git common dir>/alfred-overwatch-outbox.jsonl` | none |

## Chrome, the native host and the panel

| # | Interface | Direction | File or channel | Version check |
|---|---|---|---|---|
| 11 | Chat watcher | `claude-watch.js` ↔ `bridge.js` | runtime messages: `chat-state` up; `send-cli`, `focus-composer`, `watch-recheck` down | none (same extension) |
| 12 | Native messaging | `bridge.js` ↔ `bridge/host.mjs` | host `com.alfred.switchboard`; frames `tabs`, `chats`, `result` up, `command` down, `hello` on connect | `hello` names the host; no version |
| 13 | Bridge files | host ↔ panel (`lib/bridge.ahk`) | `%LOCALAPPDATA%\claude-sessions\bridge\`: `tabs.json`, `chats.json`, `result.json` (host writes, each stamped `at`, `origin`, `extension_id`); `command.json` (panel writes, host deletes) | none; the panel ignores a `tabs.json` or `chats.json` older than 45 s (`IsFresh`) |
| 14 | Touch page | panel ↔ `ui/switchboard.html` (WebView2) | `PostWebMessageAsJson` of `TouchState()` (`type: "state"`, tiles) down; `TouchCommand` messages up | none |

## Alfred (Supabase)

| # | Interface | Direction | Endpoint | Auth | Version check |
|---|---|---|---|---|---|
| 15 | Clipboard push | `clip.mjs` → Alfred | `CLIPBOARD_URL` `/finish` (`clip-capture`), base64 title and text, `run_tag`, `repo`, `branch` | `CLIPBOARD_SECRET` header | by behaviour: a 400 on `page_text` falls back to plain text; a stored `run_tag` that differs from the one sent is flagged |
| 16 | Activity | `overwatch-post.mjs` → Alfred | `OVERWATCH_INGEST_URL` (`overwatch-ingest`): claim blocks, finish summaries (`scripts/lib/finish-summary.mjs`) | `OVERWATCH_INGEST_SECRET` | none |
| 17 | Reports to claude.ai | Alfred → claude.ai | MCP `get_recent_clips` by `run_tag` / `run_tag_prefix`; `archive_inbox_item` | MCP connector | none |

Planned, not built: report status (Phase 1, spec §4 item 3), the action queue
(Phase 2, item 4), and the Switchboard MCP tools (items 5).
