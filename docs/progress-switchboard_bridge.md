# Progress: Switchboard bridge

Spec: [technical-spec-switchboard_bridge.md](technical-spec-switchboard_bridge.md). Thread: `switchboard_bridge-p8v`.

**Status (2026-10-03, s13):**
- Steps 1–10 are built, and verified live.
- The s12 changes (the pointer follows the keyboard, and the diagnostics are removed) are being checked live.
- Step 11 is prepared and waiting for gitpush Finish.

## Claims

There are 26 paths claimed, and no database items.

- **Host:** `tools/claude-sessions/bridge/`, `run-tests.ps1`, `README.md`
- **Panel:** `claude-sessions.ahk`, `lib/status.ahk`, `lib/bridge.ahk`, `test-status.ahk`, `smoke-test.ahk`
- **Extension:** `manifest.json`, `bridge.js`, `claude-watch.js`, `lib/bridge-core.js`, `lib/bridge-core.test.mjs`, `service-worker.js` (one import line only), `README.md`
- **Signals and skill (s2b):** `.claude/hooks/prompt-check.mjs`, `scripts/clip.mjs`, `.claude/skills/cli-workflow/SKILL.md`
- **Docs:** `docs/technical-spec-switchboard_bridge.md`, `docs/progress-switchboard_bridge.md`, `docs/technical-spec-switchboard.md`
- **Signals (s3):** `scripts/lib/session-status.mjs`, `scripts/lib/session-status.test.mjs`, `scripts/lib/hooks.test.mjs`, `scripts/lib/last-report.mjs` (new), `scripts/lib/last-report.test.mjs` (new)

## Steps

Every panel step: **quit the live Switchboard first**, then double-click the worktree's `claude-sessions.ahk`. Every extension step: the daily extension is switched off, and the worktree copy is loaded and holds the secret.

- [x] **1. Plan and docs.**
  - Plan confirmed 2026-10-02. Wrote the spec and this file, and a pointer in `technical-spec-switchboard.md`.
  - Revised in s2b: the unknown chat state, the state model, run-tag signals, Send cli, and the skill rules.
- [x] **2. CLI-side signals.** Verified live by Alex 2026-10-02 (s3b): `run_tag` was s3b-q7ne with state `waiting`, and `last-report.json` went from s3-v2kd to s3b-q7ne.
  - prompt-check passes the tag, and the status writer records `run_tag` and carries it over.
  - `clip.mjs` writes `.clip/last-report.json`.
  - [x] Written:
    - prompt-check sets `entry.tag` and passes it only on allowed (processing) writes.
    - `nextStatus` carries `run_tag` over.
    - New `scripts/lib/last-report.mjs`.
    - `clip.mjs` writes the record only for the checkout's own `.clip/last-report.md`.
  - [x] Tests: 1 new in `session-status.test.mjs`, 2 in `hooks.test.mjs` (a repeated tag is accepted, and the first of two different tags wins), 4 in `last-report.test.mjs`. CLI 113/113, app 2019/2019. The hook was smoke-run after the edit.
  - [x] Live: verified in s3b.
  - **Test:** the CLI suite (new writer, hook and last-report tests). Then, live in this worktree:
    - the next tagged prompt puts `run_tag` in the status file;
    - a clip push writes `last-report.json`;
    - a prompt whose tag appears twice is accepted.
- [x] **3. cli-workflow skill.** Verified by Alex 2026-10-02 (s5): uploaded, and a fresh chat's prompt starts and ends with the same tag.
  - **s5 fix to prompt-check.** IDE context blocks are stripped before the tag is looked for. A selection of SKILL.md had blocked a prompt as the wrong window. There is a test in `hooks.test.mjs`.
  - Add the two rules: one prompt at a time, and the tag repeated as the last line.
  - [x] Written:
    - The run-tag section says the tag is repeated as the last line of the prompt block.
    - New "One prompt at a time" subsection.
    - The return leg says a prompt that must not be pasted carries no `Run tag:` line.
    - Both templates and both examples now use the current shape, end with the tag, and have a `Window:` line.
  - **Test:** read the edited section. Alex re-uploads the skill to claude.ai, and the next prompt Claude writes ends with its `Run tag:` line.
- [x] **4. Host and install.** Verified by Alex 2026-10-02 (s6): try-host printed hello and the focus command for tab 102, and exited 0. The bridge folder held only the two JSON files with the fake id, plus host.log. The stray folder in main has been deleted. `install.ps1` runs for real in step 5.
  - [x] Built `host.mjs`, `host.bat`, `host-manifest.template.json`, `install.ps1`, `host.test.mjs` (9 tests), `try-host.mjs`, and added the host tests to `run-tests.ps1`.
  - [x] Tests: run-tests.ps1 all passed; CLI 114/114, app 2019/2019. try-host against a scratch folder wrote `tabs.json`, `chats.json` and `host.log`, and the host sent only `hello` and the forwarded command.
  - Build `host.mjs`, `host.bat`, the manifest template, `install.ps1 -ExtensionId` and `host.test.mjs`, and add the host tests to `run-tests.ps1`.
  - **Test:** `host.test.mjs`. Then a scratch Node client launches `host.bat`, sends framed messages, and checks the files in a scratch folder, an ignored stdout, a forwarded command and EOF shutdown. Then check the registry value and the manifest.
- [x] **5. Extension writes the tabs list.** Verified by Alex 2026-10-02 (s7). Both ids found and the host installed. `tabs.json` listed every tab with the test id, a new tab appeared, and `at` moved. Both copies clipped. The test copy stays loaded but off.
  - [x] `bridge.js`, `lib/bridge-core.js` with 5 tests, the `tabs` and `nativeMessaging` permissions (no `key`, no content script yet), and the one import line in `service-worker.js`.
  - [x] Tests: bridge-core 5/5 and plan 39/39. `bridge.js` was loaded under a fake `chrome` three ways: no host (gave up, sent nothing), a host (sent a normalised tab list on hello), and no chrome APIs (loaded without throwing). CLI 114/114, app 2019/2019, run-tests.ps1 passed.
  - Manifest permissions, the one import line, `bridge.js` connect/backoff/heartbeat, and `lib/bridge-core.js` with its tests.
  - **Test:** `node extension/lib/bridge-core.test.mjs`. On the desktop:
    - `tabs.json` lists every tab in every window, with the test copy's `origin`;
    - its `at` advances every 15 s;
    - clipping still works.
- [x] **6. Focus command.** Verified by Alex 2026-10-02 (s8): a background tab in a background window became active, with ok and its title; tab 999999 replied ok false, "no tab with id 999999", and nothing moved.
  - [x] `bridge.js` handles `focus` (pickTab, focusResult in bridge-core). New hand check `bridge/focus-tab.mjs`. The host was unchanged apart from a result.json test.
  - [x] Tests:
    - bridge-core 7/7, host 10/10, plan 39/39, CLI 114/114, app 2019/2019, run-tests.ps1 passed.
    - A scratch end-to-end run (the real host and the real bridge.js under a fake chrome, plus focus-tab.mjs) covered three cases: tab 7 was focused with ok and the title; tab 999 gave `ok: false` and "no tab with id 999"; a `--url` with a query was focused.
  - **Test:** write a `command.json` by hand for a background tab in a background window. That tab comes forward, and `result.json` has the same id with `ok: true`. A bad tabId gives `ok: false`.
- [x] **7. Panel pairs by address.** Verified by Alex 2026-10-02 (s9): a saved-link chat in a background tab of a background window came forward on monitor 2, maximized, and nothing else moved. With the test copy off and the file stale, the old title and saved-link behaviour ran.
  - [x] New `lib/bridge.ahk`: `ReadTabs`, `TabsFresh`, `SendFocus` and `BridgeArrange`. Pure helpers in `lib/status.ahk`: `NormaliseUrl`, `IsFresh`, `FindTabByLink`, `WindowTitleStarts`. `BRIDGE_DIR` comes from `[panel] bridge=`. `Arrange` tries the bridge first, and the old path below it is unchanged.
  - [x] Tests: test-status (+10 checks); smoke-test (+9: pairs and places by title, and falls back on a stale file, no matching tab, a failed focus or no reply). run-tests.ps1 passed, CLI 114/114, app 2019/2019.
  - **Not done here, by design:** finding a link from every tab's title when none is saved. With no saved link, the old title match still runs and still saves the active tab's link.
  - The scratch end-to-end check of the real `SendFocus` was blocked by the claims guard: a false positive on `$SP` paths in the scratchpad. It was not retried.
  - Exact-address pairing, finding a link across every tab, and click → focus → activate by window title, with the stale fallback.
  - **Test:** `run-tests.ps1`. On the desktop, quit the live panel first:
    - a background-tab chat comes forward on click;
    - with the extension off, the old title match still works.
- [x] **8. claude.ai watcher.** Verified by Alex 2026-10-03 (s10) on the live page:
  - finished with issuedTag null (the latest message had no tag);
  - responding, then finished with a new since;
  - composerEmpty flipped, with the typed text not in the file;
  - viewedAt moves while the tab is in view.
  - **The gap:** a brand-new chat was unknown until it had a `/chat/` address. Fixed in s10, with address-change checks.
  - [x] Built `claude-watch.js`, the claude.ai host permission plus the content script in the manifest, `bridge.js` (report store, viewedAt, injection on hello), and `buildChatsMessage` in bridge-core.
  - [x] Tests: bridge-core 11/11 (watcher state, tag extraction, chat paths, chat list). A scratch jsdom run of the real watcher went idle → responding → finished only after it held → `unknown` when the box went away. Typed text never appeared in a report, and with no change nothing was sent. plan 39/39, CLI 114/114, app 2019/2019, run-tests.ps1 passed.
  - `responding` / `finished` / `unknown`, `issuedTag`, `composerEmpty` and `viewedAt`, plus injection into tabs already open.
  - **Test:** in one chat:
    - a prompt goes `responding`, then `finished`;
    - a reply ending in a `Run tag:` line sets `issuedTag`;
    - typing in the box flips `composerEmpty`;
    - a discarded tab is `unknown`;
    - a broken selector (edited in the test copy) gives `unknown`;
    - grep the bridge folder for a phrase from the chat and find nothing.
- [x] **9. Panel state model.** Verified live by Alex 2026-10-03 (s11b):
  - A purple click put the cursor in the chat's message box.
  - A green CLI click left VS Code in front with the keyboard.
  - An orange click put the cursor in the message box, and the typed "cli" plus Enter arrived in the chat.
  - The unpaired chat row went green, then yellow with 5 flashes. On click it brought the tab forward with the cursor in its box, and turned grey `seen`.
  - [x] Colours and labels (`ViewOf`), the run-tag step on the label, the "Step N of M" tooltip, 5 flashes for every attention colour, the taskbar priority, the unpaired chat rows (up to 8, click to focus), and link learning. Purple and orange clicks only arrange.
  - [x] Tests: test-status (+30 checks); smoke-test (+21: one project through every colour, chat rows, learning a link). run-tests.ps1 passed. CLI 114/114, app 2019/2019, bridge-core 11/11, plan 39/39. In jsdom, a new chat's address change was reported in 250 ms.
  - Two smoke checks on the live taskbar colour were dropped: real worktree sessions on the machine feed it. The rule is tested in test-status instead.
  - **s10 walk-through failed at purple.** A reply whose code block held the tag gave `issuedTag: null`. In s10c the watcher now finds the outermost latest message by one selector at a time, reads each `<pre>` block's own text, and tolerates spaces before "Run tag:". There are temporary diagnostic fields in `chats.json`, and a jsdom test with a tagged code block.
  - **Verified live 2026-10-03 (s10d).** The panel showed purple for `switchboard_bridge-p8v-s10d-w2fz`. `chats.json` had that issuedTag, latestFound true, `streamingAttr`, codeBlocks 2 and tagLines 2.
  - **s10d, keyboard focus after a click.**
    - Red, and green while the CLI works (CLI working or Both working), activate VS Code last.
    - Every other colour, and the chat rows, places Chrome last and sends `composer: true` on the focus command. The watcher then puts the cursor at the end of the message box and types nothing.
    - Tests: test-status +7 (`FocusTarget`), smoke +7, host +1, bridge-core +1 (jsdom). All suites passed. Waiting for the desktop check.
  - Added s9: when a session has no saved chat link and `tabs.json` is fresh, find a `claude.ai/chat` tab whose title contains the project code, in any tab of any window, and save that link.
  - The colours, labels and step text from section 5 of the spec, plus the tooltip, flashing for every attention colour, taskbar priority and the unpaired chat rows.
  - **Test:** `run-tests.ps1`, with one smoke case per row of the state table and one per chat-row state. On the desktop, quit the live panel first: walk one project through green → orange → yellow → purple → green.
- [x] **10. Send cli.** Verified live by Alex 2026-10-03 (s12):
  - With "draft" in the box, an orange click only focused and left it untouched.
  - With an empty box, an orange click typed and sent "cli" by itself.
  - Mid-reply, `focus-tab.mjs --sendcli` replied ok true and did "typed", and the "cli" sat unsent.
  - **s12, the pointer follows the keyboard.**
    - After a button or chat-row click, the mouse pointer moves to the centre of the window that got the keyboard: VS Code for red and a working CLI, Chrome otherwise.
    - `MovePointerTo` uses `SetCursorPos` per-monitor DPI aware. `[panel] pointer=0` turns it off.
    - The temporary watcher diagnostics were removed; the robust tag reading stays.
    - Tests: test-status +3 (`WindowCentre`), smoke +6. Waiting for the desktop check.
  - [x] The orange click sends `sendcli`. The extension focuses the tab, and the watcher's `sendCli` decides on the live page between sent, typed and focused. `did` comes back in `result.json`.
  - [x] Tests: smoke +5 (orange sends `sendcli`; yellow and purple send `focus`; the real command file), bridge-core +3 (`cliPlan`, and four jsdom pages: sent, typed, a draft left alone, unknown). run-tests.ps1 passed, CLI 114/114, app 2019/2019, plan 39/39.
  - Real-page assumptions to prove: `insertText` works on claude.ai's editor, and the send button's aria-label contains "Send".
  - **Test:** `run-tests.ps1` (command written). On the desktop, quit the live panel first, then check all three cases: empty and idle sends; empty and writing types without sending; text in the box, or `unknown`, only focuses.
- [ ] **11. README, spec, suites, Finish.** Prepared in s13, 2026-10-03.
  - [x] `extension/README.md`: the bridge, setup on a PC, exactly what is read and never read, focus and Send cli, behaviour with no host, the two-copies rule, and the files table.
  - [x] `tools/claude-sessions/README.md`: new-PC setup, reading the buttons, the `[panel]` settings, the bridge folder and hand checks, and tests.
  - [x] `technical-spec-switchboard.md` points to section 5 of this project's spec, which wins on colours and clicks. The bridge spec now matches the build: commands, focus and sendcli, tooltip, link learning, clicks, and the 2026-10-03 decisions.
  - [x] Suites run in s13 (see report).
  - [ ] Check that on a machine with no host, the extension clips and stays quiet. The Surface needs the daily extension reloaded after Finish.
  - [ ] Alex runs gitpush Finish.
  - [ ] **Then, from main:**
    - Rerun `install.ps1` with only the daily id.
    - Reload the daily extension, switch it back on, and remove the test copy.
    - Restart the live Switchboard.

## Notes

- **Decisions, 2026-10-02** (Alex):
  - The bridge folder is `%LOCALAPPDATA%\claude-sessions\bridge\`, with `[panel] bridge=`.
  - Only one copy of the extension is enabled while testing, and the host records the writer's origin.
  - `install.ps1` is rerun from main after Finish.
  - Each panel step quits the live Switchboard.
- **s2b** (Alex):
  - `install.ps1 -ExtensionId <daily>,<test>`.
  - A watcher that cannot read the page reports `unknown`.
  - The state model and Send cli.
  - Only run tags leave a chat.
  - The skill gains its two rules.
  - Hook changes need no fresh session (spec section 7).
