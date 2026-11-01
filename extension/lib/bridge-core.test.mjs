// Run: node extension/lib/bridge-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  approveBanner, approveTokenOf, approveWatcher, buildChatsMessage, buildTabsMessage, checkPrompt, chatForProject, chatForRun, cleanHosts, cleanRun, closesApproveTab, debounce, focusResult,
  GRANT_BADGE, grantNotice, hostOrigins, isApprovePage, isHostMissing, nextDelay, normaliseUrl, pickTab, postProblem, projectOfTag, promptFrame, pruneApprovals, sendTagOf,
} from "./bridge-core.js";
import "../claude-watch.js";

const { decideState, extractTag, isChatPath } = globalThis.__alfredWatchCore;

test("watcher: unknown unless the box and the stop/send area are found", () => {
  assert.equal(decideState({ composer: false, stop: true }), "unknown");
  assert.equal(decideState({ composer: true }), "unknown");
  assert.equal(decideState({ composer: true, stop: true }), "responding");
  assert.equal(decideState({ composer: true, send: true, streaming: true }), "responding");
  assert.equal(decideState({ composer: true, send: true }), "finished");
});

test("watcher: only a prompt header counts, the last one wins", () => {
  assert.equal(extractTag("Run tag: a-b1c-s9-c8tv\nWindow: x\n\nbody\n\nRun tag: a-b1c-s9-c8tv"), "a-b1c-s9-c8tv");
  assert.equal(
    extractTag("Run tag: a-b1c-s3-aaaa\nWindow: x\nlater\nRun tag: a-b1c-s4-bbbb\n\nWindow: x"),
    "a-b1c-s4-bbbb",
  );
  // A chat reply that only quotes a tag is not a prompt to paste.
  assert.equal(extractTag("The CLI finished.\nRun tag: a-b1c-s4-bbbb\nNext, test it."), null);
  assert.equal(extractTag("Run tag: a-b1c-s3-aaaa\nlater\nRun tag: a-b1c-s4-bbbb"), null);
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

  const classOnly = new JSDOM(`<body><div class="font-claude-response"><pre>Run tag: proj-abc-s3-cccc\nWindow: main</pre></div></body>`).window.document;
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

const PROMPT = "Run tag: sb-h8r-s13-q2vx\nWindow: the sb-h8r worktree\n\nScope of this step:\n- create: nothing\n\nDo it.\n\nRun tag: sb-h8r-s13-q2vx";

test("send prompt: the last whole prompt, header to closing tag", () => {
  const { extractPrompt } = globalThis.__alfredWatchCore;
  assert.deepEqual(extractPrompt(`Here it is.\n\n${PROMPT}\n`), { tag: "sb-h8r-s13-q2vx", text: PROMPT });
  const older = PROMPT.replaceAll("s13-q2vx", "s12-aaaa");
  assert.equal(extractPrompt(`${older}\n\n${PROMPT}`).tag, "sb-h8r-s13-q2vx");
  // No closing tag line: not finished, so not sent.
  assert.equal(extractPrompt("Run tag: sb-h8r-s13-q2vx\nWindow: x\nbody"), null);
  assert.equal(extractPrompt("The CLI said:\nRun tag: sb-h8r-s13-q2vx\nall good"), null);
});

test("send prompt: read from the code block of Claude's latest message", async (t) => {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    return t.skip("jsdom not installed");
  }
  const { readPrompt } = globalThis.__alfredWatchCore;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const { document } = new JSDOM(
    `<div class="font-claude-response"><pre>${esc(PROMPT.replaceAll("s13-q2vx", "s12-aaaa"))}</pre></div>` +
      `<div class="font-claude-response"><p>Scope summary.</p><pre>${esc(PROMPT)}</pre></div>`,
  ).window;
  assert.deepEqual(readPrompt(document), { tag: "sb-h8r-s13-q2vx", text: PROMPT });
});

test("send prompt: the tag's project must be the window's, and the tag new", () => {
  const prompt = { tag: "sb-h8r-s13-q2vx", text: PROMPT };
  assert.equal(projectOfTag("sb-h8r-s13-q2vx"), "sb-h8r");
  assert.equal(projectOfTag("parallel_threads-k4q-s3b-k2np"), "parallel_threads-k4q");
  assert.equal(projectOfTag("nope"), null);
  assert.equal(checkPrompt({ tag: "sb-h8r-s13-q2vx" }, prompt), null);
  assert.match(checkPrompt({ tag: "sb-h8r-s13-q2vx" }, null), /no whole CLI prompt/);
  assert.match(checkPrompt({ tag: "sb-h8r-s13-q2vx", project: "jobs-ax4" }, prompt), /for sb-h8r, not jobs-ax4/);
  assert.match(checkPrompt({ tag: "sb-h8r-s13-q2vx", sentTag: "sb-h8r-s13-q2vx" }, prompt), /already sent/);
  assert.match(checkPrompt({ tag: "sb-h8r-s14-zzzz" }, prompt), /link is for sb-h8r-s14-zzzz, the prompt is sb-h8r-s13-q2vx/);
});

test("send link: only /send/<tag> on a listed host, by https", () => {
  const hosts = ["alfredv5vibe.vercel.app"];
  const { sendTagOf: watchTagOf } = globalThis.__alfredWatchCore;
  const cases = [
    ["https://alfredv5vibe.vercel.app/send/sb-h8r-s13-q2vx", "sb-h8r-s13-q2vx"],
    ["https://ALFREDV5VIBE.vercel.app/send/sb-h8r-s13-q2vx?x=1#y", "sb-h8r-s13-q2vx"],
    ["https://evil.example/send/sb-h8r-s13-q2vx", null],
    ["https://x.alfredv5vibe.vercel.app/send/sb-h8r-s13-q2vx", null],
    ["http://alfredv5vibe.vercel.app/send/sb-h8r-s13-q2vx", null],
    ["https://alfredv5vibe.vercel.app/sendx/sb-h8r-s13-q2vx", null],
    ["https://alfredv5vibe.vercel.app/send/not-a-tag", null],
    ["not a url", null],
  ];
  for (const [href, want] of cases) {
    assert.equal(sendTagOf(href, hosts), want, href);
    assert.equal(watchTagOf(href, hosts), want, `watcher: ${href}`);
  }
  assert.equal(sendTagOf(cases[0][0], []), null);
  assert.deepEqual(cleanHosts(["Alfredv5vibe.vercel.app", "bad host", 7, "https://x.y"]), ["alfredv5vibe.vercel.app"]);
});

test("send link: the prompt frame carries the text only when it passed", () => {
  assert.deepEqual(promptFrame("p1", "sb-h8r-s13-q2vx", { tag: "sb-h8r-s13-q2vx", text: PROMPT }, null),
    { type: "prompt", id: "p1", tag: "sb-h8r-s13-q2vx", text: PROMPT });
  assert.deepEqual(promptFrame("p2", "sb-h8r-s13-q2vx", { tag: "sb-h8r-s13-q2vx", text: PROMPT }, "already sent"),
    { type: "prompt", id: "p2", tag: "sb-h8r-s13-q2vx", error: "already sent" });
});

// Three replies; the last two carry prompts, and the link sits in the given one.
async function chatPage(t, { linkIn = 2, linkTag = "sb-h8r-s13-q2vx", host = "alfredv5vibe.vercel.app" } = {}) {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    t.skip("jsdom not installed");
    return null;
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const link = `<p><a href="https://${host}/send/${linkTag}">Send to CLI</a></p>`;
  const older = PROMPT.replaceAll("s13-q2vx", "s12-aaaa");
  const replies = [`<p>Plain talk.</p>`, `<pre>${esc(older)}</pre>`, `<pre>${esc(PROMPT)}</pre>`];
  const html = replies.map((r, i) => `<div class="font-claude-response">${r}${i === linkIn ? link : ""}</div>`).join("");
  const { document } = new JSDOM(`<body>${html}</body>`).window;
  return { document, anchor: document.querySelector("a") };
}

test("send link: the prompt comes from the link's own reply, the latest with a prompt", async (t) => {
  const { promptForLink } = globalThis.__alfredWatchCore;
  const ok = await chatPage(t);
  if (!ok) return;
  assert.deepEqual(promptForLink(ok.anchor, "sb-h8r-s13-q2vx"), { prompt: { tag: "sb-h8r-s13-q2vx", text: PROMPT }, error: null });
  const older = await chatPage(t, { linkIn: 1, linkTag: "sb-h8r-s12-aaaa" });
  assert.match(promptForLink(older.anchor, "sb-h8r-s12-aaaa").error, /older reply/);
  const wrongTag = await chatPage(t, { linkTag: "sb-h8r-s14-zzzz" });
  assert.match(promptForLink(wrongTag.anchor, "sb-h8r-s14-zzzz").error, /link is for sb-h8r-s14-zzzz, the prompt is sb-h8r-s13-q2vx/);
  const noPrompt = await chatPage(t, { linkIn: 0 });
  assert.match(promptForLink(noPrompt.anchor, "sb-h8r-s13-q2vx").error, /older reply|no whole CLI prompt/);
});

test("send link: a listed link's click is stopped before navigation; others are not", async (t) => {
  const { onLinkClick } = globalThis.__alfredWatchCore;
  const listed = await chatPage(t);
  if (!listed) return;
  const unlisted = await chatPage(t, { host: "evil.example" });
  const fire = ({ document, anchor }) => {
    const seen = [];
    const handler = (e) => onLinkClick(e, ["alfredv5vibe.vercel.app"], (a, tag) => seen.push(tag));
    document.addEventListener("click", handler, true);
    const ev = new document.defaultView.MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, seen };
  };
  assert.deepEqual(fire(listed), { prevented: true, seen: ["sb-h8r-s13-q2vx"] });
  assert.deepEqual(fire(unlisted), { prevented: false, seen: [] });
});

const RUN = "b9a740a5-53e3-409f-a503-122ec57e310a";

test("approve page: https, a listed host, /approve/<token>", () => {
  const hosts = ["alfredv5vibe.vercel.app"];
  assert.equal(isApprovePage("https://alfredv5vibe.vercel.app/approve/abc123", hosts), true);
  assert.equal(isApprovePage("https://alfredv5vibe.vercel.app/approve/abc123?code=x", hosts), true);
  assert.equal(isApprovePage("https://evil.example/approve/abc123", hosts), false);
  assert.equal(isApprovePage("http://alfredv5vibe.vercel.app/approve/abc123", hosts), false);
  assert.equal(isApprovePage("https://alfredv5vibe.vercel.app/approve/", hosts), false);
  assert.equal(isApprovePage("https://alfredv5vibe.vercel.app/send/abc123", hosts), false);
  assert.equal(isApprovePage("nope", hosts), false);
});

test("approve link: the token, by the same rule in the bridge and the watcher", () => {
  const hosts = ["alfredv5vibe.vercel.app"];
  const { approveTokenOf: watchTokenOf } = globalThis.__alfredWatchCore;
  const cases = [
    ["https://alfredv5vibe.vercel.app/approve/abc123", "abc123"],
    ["https://ALFREDV5VIBE.vercel.app/approve/abc123/?code=x#y", "abc123"],
    ["https://evil.example/approve/abc123", null],
    ["http://alfredv5vibe.vercel.app/approve/abc123", null],
    ["https://alfredv5vibe.vercel.app/approve/", null],
    ["https://alfredv5vibe.vercel.app/send/abc123", null],
    ["nope", null],
  ];
  for (const [href, want] of cases) {
    assert.equal(approveTokenOf(href, hosts), want, href);
    assert.equal(watchTokenOf(href, hosts), want, `watcher: ${href}`);
  }
});

test("approve link: a click is noted and still opens normally", async (t) => {
  const { onApproveClick } = globalThis.__alfredWatchCore;
  const w = await dom(t, `<a id="a" href="https://alfredv5vibe.vercel.app/approve/abc123">Approve</a><a id="b" href="https://evil.example/approve/abc123">No</a>`);
  if (!w) return;
  const seen = [];
  w.document.addEventListener("click", (e) => onApproveClick(e, ["alfredv5vibe.vercel.app"], (href) => seen.push(href)), true);
  for (const id of ["a", "b"]) {
    const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true });
    w.document.getElementById(id).dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
  }
  assert.deepEqual(seen, ["https://alfredv5vibe.vercel.app/approve/abc123"]);
});

test("chatForRun: the clicked tab wins while it shows the same chat; else the matching", () => {
  const clicked = { tabId: 7, url: "https://claude.ai/chat/one", title: "Untitled", issuedTag: null };
  const titled = { tabId: 8, url: "https://claude.ai/chat/two", title: "switchboard2-h8r - Claude", issuedTag: null };
  const from = { tabId: 7, url: "https://claude.ai/chat/one" };
  assert.equal(chatForRun([clicked, titled], { project: "switchboard2-h8r", from }).chat.tabId, 7);
  // Two title matches would post nothing, but a click still knows its tab.
  const twin = { ...titled, tabId: 9 };
  assert.equal(chatForRun([clicked, titled, twin], { project: "switchboard2-h8r", from }).chat.tabId, 7);
  // No click (the phone), the tab gone, or the tab moved to another chat: the matching.
  assert.equal(chatForRun([clicked, titled], { project: "switchboard2-h8r" }).chat.tabId, 8);
  assert.equal(chatForRun([titled], { project: "switchboard2-h8r", from }).chat.tabId, 8);
  const moved = { ...clicked, url: "https://claude.ai/chat/other" };
  assert.equal(chatForRun([moved, titled], { project: "switchboard2-h8r", from }).chat.tabId, 8);
});

test("the approve tab closes only once the line is sent, and only if it is still that page", () => {
  const hosts = ["alfredv5vibe.vercel.app"];
  const page = "https://alfredv5vibe.vercel.app/approve/abc123";
  assert.equal(closesApproveTab("sent", page, hosts), true);
  assert.equal(closesApproveTab("typed", page, hosts), false);
  assert.equal(closesApproveTab("busy", page, hosts), false);
  assert.equal(closesApproveTab(undefined, page, hosts), false);
  assert.equal(closesApproveTab("sent", "https://alfredv5vibe.vercel.app/", hosts), false);
  assert.equal(closesApproveTab("sent", "https://claude.ai/chat/one", hosts), false);
});

test("postProblem: why a line can't go yet, in plain words, or null", () => {
  const chat = { state: "finished", composerEmpty: true };
  assert.equal(postProblem(chat, null), null);
  assert.match(postProblem(null, "no open chat for p-x"), /no open chat for p-x/);
  assert.match(postProblem({ ...chat, state: "responding" }, null), /still writing/);
  assert.match(postProblem({ ...chat, composerEmpty: false }, null), /message box has text/);
  assert.match(postProblem({ ...chat, composerEmpty: null }, null), /message box/);
  assert.match(postProblem({ ...chat, state: "unknown" }, null), /can't read/);
});

test("approvals: old clicks and seen runs are dropped; waiting runs stay", () => {
  const now = 10 * 24 * 3600 * 1000;
  const out = pruneApprovals({
    hosts: ["a.b"],
    clicks: { old: { tabId: 1, url: "u", at: now - 3700 * 1000 }, fresh: { tabId: 2, url: "u", at: now - 60 * 1000 } },
    runs: [{ runId: RUN, at: now - 3700 * 1000 }],
    seen: { [RUN]: now - 25 * 3600 * 1000, other: now - 3600 * 1000 },
  }, now);
  assert.deepEqual(Object.keys(out.clicks), ["fresh"]);
  assert.deepEqual(Object.keys(out.seen), ["other"]);
  assert.equal(out.runs.length, 1);
  assert.deepEqual(out.hosts, ["a.b"]);
  // Anything stored wrongly, or nothing stored, reads as empty.
  assert.deepEqual(pruneApprovals(undefined, now), { hosts: [], clicks: {}, runs: [], seen: {} });
  assert.deepEqual(pruneApprovals({ hosts: 1, clicks: null, runs: "x", seen: 2 }, now), { hosts: [], clicks: {}, runs: [], seen: {} });
});

test("approve banner: says it on the page, once, and replaces its own words", async (t) => {
  const w = await dom(t, "");
  if (!w) return;
  const run = new Function("document", `return (${approveBanner.toString()})(...[...arguments].slice(1));`);
  run(w.document, "first <b>");
  run(w.document, "second <b>");
  const shown = w.document.querySelectorAll("[data-alfred-post-note]");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].textContent, "second <b>");
  assert.equal(shown[0].querySelector("b"), null);
});

test("host access: origins from the list, and a notice only when one is missing", () => {
  assert.deepEqual(hostOrigins(["alfredv5vibe.vercel.app", "alfred.example:8443"]), ["https://alfredv5vibe.vercel.app/*", "https://alfred.example/*"]);
  assert.equal(grantNotice([]), null);
  const notice = grantNotice(["alfredv5vibe.vercel.app"]);
  assert.equal(notice.badge, GRANT_BADGE);
  assert.match(notice.title, /alfredv5vibe\.vercel\.app/);
  assert.match(notice.title, /right-click/i);
});

test("manifest: no Alfred host in the code, asked for at run time", () => {
  const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(m.version, "1.2.3");
  assert.equal(m.host_permissions.some((h) => /vercel\.app/.test(h)), false);
  assert.deepEqual(m.optional_host_permissions, ["https://*/*"]);
});

test("cleanRun: a UUID and a project code, or null", () => {
  assert.deepEqual(cleanRun({ runId: RUN, project: "switchboard2-h8r", extra: 1 }), { runId: RUN, project: "switchboard2-h8r" });
  assert.equal(cleanRun({ runId: "x", project: "p" }), null);
  assert.equal(cleanRun({ runId: RUN, project: "Bad Project" }), null);
  assert.equal(cleanRun(null), null);
});

test("chatForProject: issued tag first, then title; two matches is none", () => {
  const a = { tabId: 1, title: "switchboard2-h8r review - Claude", issuedTag: null };
  const b = { tabId: 2, title: "Untitled - Claude", issuedTag: "switchboard2-h8r-s9-abcd" };
  const other = { tabId: 3, title: "Taxes - Claude", issuedTag: "wb-x1y-s1-aaaa" };
  assert.equal(chatForProject([a, other], "switchboard2-h8r").chat.tabId, 1);
  assert.equal(chatForProject([a, b, other], "switchboard2-h8r").chat.tabId, 2);
  assert.equal(chatForProject([other], "switchboard2-h8r").chat, null);
  assert.match(chatForProject([other], "switchboard2-h8r").why, /no open chat/);
  const twin = { tabId: 4, title: "switchboard2-h8r again - Claude", issuedTag: null };
  assert.equal(chatForProject([a, twin], "switchboard2-h8r").chat, null);
  assert.match(chatForProject([a, twin], "switchboard2-h8r").why, /2 chats/);
  // A longer code is another project.
  assert.equal(chatForProject([{ tabId: 5, title: "switchboard2-h8rx - Claude", issuedTag: null }], "switchboard2-h8r").chat, null);
});

async function dom(t, html) {
  let JSDOM;
  try {
    ({ JSDOM } = await import("jsdom"));
  } catch {
    t.skip("jsdom not installed");
    return null;
  }
  return new JSDOM(`<body>${html}</body>`).window;
}

const APPROVE_HTML = `<p>Project</p><p>wrong-label</p><p data-switchboard-project="switchboard2-h8r">shown</p><div id="r"></div>`;

test("approve watcher: a dry run sends nothing; a real run sends its id once per injection", async (t) => {
  const w = await dom(t, APPROVE_HTML);
  if (!w) return;
  const sent = [];
  const scope = { document: w.document, MutationObserver: w.MutationObserver, chrome: { runtime: { sendMessage: async (m) => sent.push(m) } } };
  const run = new Function(...Object.keys(scope), `return (${approveWatcher.toString()})();`);
  run(...Object.values(scope));
  w.document.getElementById("r").innerHTML = "<p>Dry run, rolled back</p>";
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);
  w.document.getElementById("r").setAttribute("data-switchboard-run-id", RUN);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [{ type: "approve-run", runId: RUN, project: "switchboard2-h8r" }]);
  w.document.getElementById("r").innerHTML = "<p>again</p>";
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  // A re-injection after an extension reload reports again; bridge.js drops a run it has seen.
  run(...Object.values(scope));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
});

test("approve watcher: a re-injection replaces the one a reload left dead", async (t) => {
  const w = await dom(t, APPROVE_HTML);
  if (!w) return;
  const sent = [];
  const make = (chrome) => new Function("document", "MutationObserver", "chrome", `return (${approveWatcher.toString()})();`)(w.document, w.MutationObserver, chrome);
  make({ runtime: { sendMessage: () => { throw new Error("Extension context invalidated."); } } });
  make({ runtime: { sendMessage: async (m) => sent.push(m) } });
  w.document.getElementById("r").setAttribute("data-switchboard-run-id", RUN);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [{ type: "approve-run", runId: RUN, project: "switchboard2-h8r" }]);
});

function composerPage(w, { box = "", stop = false, onSend = () => {} } = {}) {
  const d = w.document;
  d.body.innerHTML = `<div contenteditable="true" role="textbox">${box}</div>` +
    (stop ? `<button aria-label="Stop"></button>` : `<button aria-label="Send"></button>`);
  d.querySelector('button[aria-label="Send"]')?.addEventListener("click", onSend);
  const typed = [];
  d.execCommand = (_c, _u, text) => { typed.push(text); return true; };
  return { document: d, typed };
}

test("postLine: types and sends only into an idle, empty chat", async (t) => {
  const { postLine } = globalThis.__alfredWatchCore;
  const w = await dom(t, "");
  if (!w) return;
  let clicks = 0;
  const idle = composerPage(w, { onSend: () => clicks++ });
  // jsdom has no innerText.
  idle.document.querySelector("[contenteditable]").innerText = "";
  assert.equal(await postLine(idle.document, `sql ${RUN}`), "sent");
  assert.deepEqual(idle.typed, [`sql ${RUN}`]);
  assert.equal(clicks, 1);

  const writing = composerPage(w, { stop: true });
  writing.document.querySelector("[contenteditable]").innerText = "";
  assert.equal(await postLine(writing.document, "sql x"), "busy");
  assert.deepEqual(writing.typed, []);

  const draft = composerPage(w, { box: "half a thought" });
  draft.document.querySelector("[contenteditable]").innerText = "half a thought";
  assert.equal(await postLine(draft.document, "sql x"), "busy");
  assert.deepEqual(draft.typed, []);
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
