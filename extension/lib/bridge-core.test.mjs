// Run: node extension/lib/bridge-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildChatsMessage, buildTabsMessage, debounce, focusResult, isHostMissing, nextDelay, normaliseUrl, pickTab } from "./bridge-core.js";
import "../claude-watch.js";

const { decideState, extractTag, isChatPath } = globalThis.__alfredWatchCore;

test("watcher: unknown unless the box and the stop/send area are found", () => {
  assert.equal(decideState({ composer: false, stop: true }), "unknown");
  assert.equal(decideState({ composer: true }), "unknown");
  assert.equal(decideState({ composer: true, stop: true }), "responding");
  assert.equal(decideState({ composer: true, send: true, streaming: true }), "responding");
  assert.equal(decideState({ composer: true, send: true }), "finished");
});

test("watcher: only a whole tag on its own Run tag line, the last one wins", () => {
  assert.equal(extractTag("Run tag: a-b1c-s9-c8tv\nWindow: x\n\nbody\n\nRun tag: a-b1c-s9-c8tv"), "a-b1c-s9-c8tv");
  assert.equal(extractTag("Run tag: a-b1c-s3-aaaa\nlater\nRun tag: a-b1c-s4-bbbb"), "a-b1c-s4-bbbb");
  assert.equal(extractTag("see Run tag: a-b1c-s3-aaaa inline"), null);
  assert.equal(extractTag("Run tag: <project-code>-s<step>-<4 chars>"), null);
  assert.equal(extractTag(""), null);
});

// A page shaped like claude.ai's: jsdom has no innerText, so the tag has to come
// from the code block's own text, which is the case that failed live in s10.
test("watcher: tag from a code block in Claude's latest message", async (t) => {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    return t.skip("jsdom not installed");
  }
  const { readTag, latestMessage } = globalThis.__alfredWatchCore;
  const msg = (body) => `<div data-is-streaming="false"><div class="font-claude-response">${body}</div></div>`;
  const { document } = new JSDOM(`<body>
    ${msg("<p>old</p><pre><code>Run tag: proj-abc-s1-aaaa</code></pre>")}
    <div data-testid="user-message">Run tag: proj-abc-s9-zzzz</div>
    ${msg(`<p>Here is the prompt.</p><pre><code>
  Run tag: proj-abc-s2-bbbb
Window: the proj-abc worktree

Do it.

​ Run tag: proj-abc-s2-bbbb
</code></pre><p>After the block.</p>`)}
  </body>`).window;
  assert.equal(latestMessage(document).by, "streamingAttr");
  assert.equal(readTag(document), "proj-abc-s2-bbbb");

  const classOnly = new JSDOM(`<body><div class="font-claude-response"><pre>Run tag: proj-abc-s3-cccc</pre></div></body>`).window.document;
  assert.deepEqual([readTag(classOnly), latestMessage(classOnly).by], ["proj-abc-s3-cccc", "responseClass"]);
  const empty = new JSDOM("<body><p>nothing</p></body>").window.document;
  assert.deepEqual([readTag(empty), latestMessage(empty).by], [null, "none"]);
});

test("watcher: focusing the message box moves the cursor and types nothing", async (t) => {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    return t.skip("jsdom not installed");
  }
  const { focusComposer } = globalThis.__alfredWatchCore;
  const { document } = new JSDOM(`<body><button id="other">x</button>
    <div contenteditable="true" class="ProseMirror"><p>draft</p></div></body>`).window;
  document.getElementById("other").focus();
  assert.equal(focusComposer(document), true);
  assert.equal(document.activeElement.className, "ProseMirror");
  assert.equal(document.querySelector(".ProseMirror").textContent, "draft");
  assert.equal(focusComposer(new JSDOM("<body></body>").window.document), false);
});

test("send cli plan: only an empty box types, only an idle chat sends", () => {
  const { cliPlan } = globalThis.__alfredWatchCore;
  assert.equal(cliPlan("finished", true), "send");
  assert.equal(cliPlan("responding", true), "type");
  assert.equal(cliPlan("finished", false), "focus");
  assert.equal(cliPlan("responding", false), "focus");
  assert.equal(cliPlan("unknown", true), "focus");
  assert.equal(cliPlan("finished", null), "focus");
});

test("send cli on a page: sent, typed or only focused", async (t) => {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    return t.skip("jsdom not installed");
  }
  const { sendCli } = globalThis.__alfredWatchCore;
  const page = (box, button) => {
    const { document } = new JSDOM(`<body><div contenteditable="true" class="ProseMirror">${box}</div>${button}</body>`).window;
    Object.defineProperty(document.defaultView.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
    const clicks = [];
    document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => clicks.push(b.getAttribute("aria-label"))));
    // jsdom has no editing commands; this stands in for the editor's insertText.
    document.execCommand = (cmd, _ui, text) => { document.querySelector(".ProseMirror").textContent += text; return true; };
    return { document, clicks, box: () => document.querySelector(".ProseMirror").textContent };
  };
  const idle = page("", '<button aria-label="Send message">s</button>');
  assert.equal(await sendCli(idle.document), "sent");
  assert.deepEqual([idle.box(), idle.clicks], ["cli", ["Send message"]]);

  const writing = page("", '<button aria-label="Stop response">x</button>');
  assert.equal(await sendCli(writing.document), "typed");
  assert.deepEqual([writing.box(), writing.clicks], ["cli", []]);

  const draft = page("<p>my draft</p>", '<button aria-label="Send message">s</button>');
  assert.equal(await sendCli(draft.document), "focused");
  assert.deepEqual([draft.box(), draft.clicks], ["my draft", []]);

  const unknown = page("", "");
  assert.equal(await sendCli(unknown.document), "focused");
  assert.equal(unknown.box(), "");
});

test("watcher: chat pages only", () => {
  assert.equal(isChatPath("/chat/0f2c"), true);
  assert.equal(isChatPath("/new"), false);
  assert.equal(isChatPath("/project/x"), false);
});

test("chats: every claude.ai chat tab; unreported or discarded is unknown", () => {
  const now = new Date("2026-10-02T11:00:00.000Z");
  const tabs = [
    { id: 1, windowId: 10, active: true, title: "A - Claude", url: "https://claude.ai/chat/a" },
    { id: 2, windowId: 10, active: false, title: "B - Claude", url: "https://claude.ai/chat/b", discarded: true },
    { id: 3, windowId: 20, active: true, title: "C - Claude", url: "https://claude.ai/chat/c?x" },
    { id: 4, windowId: 20, active: false, title: "Mail", url: "https://mail.example/" },
    { id: 5, windowId: 20, active: false, title: "New", url: "https://claude.ai/new" },
  ];
  const reports = new Map([
    [1, { url: "https://claude.ai/chat/a", state: "finished", since: "t1", issuedTag: "p-abc-s1-aaaa", composerEmpty: true }],
    [2, { url: "https://claude.ai/chat/b", state: "responding", since: "t2" }],
    [3, { url: "https://claude.ai/chat/old", state: "finished", since: "t3" }],
  ]);
  const { chats } = buildChatsMessage(tabs, [{ id: 10, focused: true }, { id: 20, focused: false }], reports,
    new Map([[3, "2026-10-02T09:00:00.000Z"]]), now);
  assert.deepEqual(chats.map((c) => [c.tabId, c.state]), [[1, "finished"], [2, "unknown"], [3, "unknown"]]);
  assert.equal(chats[0].issuedTag, "p-abc-s1-aaaa");
  assert.equal(chats[0].viewedAt, "2026-10-02T11:00:00.000Z");
  assert.equal(chats[1].viewedAt, null);
  assert.equal(chats[2].viewedAt, "2026-10-02T09:00:00.000Z");
  assert.equal(chats[2].url, "https://claude.ai/chat/c");
  assert.deepEqual(Object.keys(chats[0]).sort(),
    ["composerEmpty", "issuedTag", "since", "state", "tabId", "title", "url", "viewedAt", "windowId"]);
});

test("a focus command picks its tab by id or address", () => {
  const tabs = [{ id: 3, url: "https://claude.ai/chat/a?x" }, { id: 4, url: "https://claude.ai/chat/b" }];
  assert.equal(pickTab({ tabId: 4 }, tabs).id, 4);
  assert.equal(pickTab({ tabId: 99 }, tabs), null);
  assert.equal(pickTab({ url: "https://claude.ai/chat/a#end" }, tabs).id, 3);
  assert.equal(pickTab({}, tabs), null);
});

test("focus replies", () => {
  assert.deepEqual(focusResult("c1", { title: "Chat - Claude" }),
    { type: "result", id: "c1", ok: true, windowTitle: "Chat - Claude", did: "focused", error: null });
  assert.equal(focusResult("c3", { title: "T" }, null, "sent").did, "sent");
  assert.deepEqual(focusResult("c2", null, "no tab with id 99"),
    { type: "result", id: "c2", ok: false, windowTitle: null, did: null, error: "no tab with id 99" });
});

test("addresses lose query and fragment", () => {
  assert.equal(normaliseUrl("https://claude.ai/chat/abc?x=1#y"), "https://claude.ai/chat/abc");
  assert.equal(normaliseUrl("chrome://newtab/"), "chrome://newtab/");
  assert.equal(normaliseUrl("not a url"), "not a url");
});

test("every tab, with its window's focus", () => {
  const msg = buildTabsMessage(
    [
      { id: 1, windowId: 10, index: 0, active: true, title: "A", url: "https://a/?q" },
      { id: 2, windowId: 20, index: 4, active: false, title: "B", pendingUrl: "https://b/", discarded: true },
    ],
    [{ id: 10, focused: false }, { id: 20, focused: true }],
  );
  assert.equal(msg.type, "tabs");
  assert.deepEqual(msg.tabs, [
    { tabId: 1, windowId: 10, index: 0, active: true, windowFocused: false, title: "A", url: "https://a/", discarded: false },
    { tabId: 2, windowId: 20, index: 4, active: false, windowFocused: true, title: "B", url: "https://b/", discarded: true },
  ]);
});

test("backoff doubles to a minute", () => {
  const seen = [];
  let d = 0;
  for (let i = 0; i < 8; i++) seen.push((d = nextDelay(d)));
  assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test("host missing or forbidden is final; a crash is not", () => {
  assert.equal(isHostMissing("Specified native messaging host not found."), true);
  assert.equal(isHostMissing("Access to the specified native messaging host is forbidden."), true);
  assert.equal(isHostMissing("Native host has exited."), false);
  assert.equal(isHostMissing(undefined), false);
});

test("debounce runs once after a burst", () => {
  const pending = new Map();
  let next = 0, calls = 0;
  const timers = {
    setTimeout: (fn) => (pending.set(++next, fn), next),
    clearTimeout: (h) => pending.delete(h),
  };
  const go = debounce(() => calls++, 500, timers);
  go(); go(); go();
  assert.equal(pending.size, 1);
  [...pending.values()][0]();
  assert.equal(calls, 1);
});
