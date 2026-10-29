// Switchboard bridge: watches one claude.ai chat and tells the service worker
// (bridge.js) whether Claude is responding. Spec:
// docs/history/technical-spec-switchboard_bridge.md, section 3, "claude.ai watcher".
// BRIDGE HALF: talks only to bridge.js, by "chat-state" messages.
//
// 🛑 NO CHAT TEXT LEAVES THIS PAGE. Each report carries the address, the title,
// the state, when it last changed, the last run tag in Claude's latest message
// (only lines that begin "Run tag:", only the tag) and whether the message box
// is empty. Never the box's text, and never any message text.
//
// The one exception is Send to CLI (switchboard2-h8r 1.2): when Alex clicks a
// Send link (/send/<tag> on a host bridge.js lists), and only then, it hands
// bridge.js the CLI prompt in that link's own reply: the lines from its
// "Run tag:"/"Window:" header to its closing "Run tag:" line, nothing around them.
//
// A classic script, not a module: content scripts cannot be modules. Node loads
// it for the tests, where `chrome` is missing and only the pure core registers.

(() => {
  // Every claude.ai selector, in one place. A redesign is fixed here.
  const SELECTORS = {
    composer: 'div[contenteditable="true"].ProseMirror, div[contenteditable="true"][role="textbox"]',
    stop: 'button[aria-label*="Stop" i]',
    send: 'button[aria-label*="Send" i]',
    streaming: '[data-is-streaming="true"]',
  };
  // Claude's messages, most stable first. Each is tried alone, and only the
  // outermost matches count, so a nested element never stands in for a message.
  const MESSAGE_SELECTORS = [
    ["streamingAttr", "[data-is-streaming]"],
    ["responseClass", ".font-claude-response"],
    ["messageClass", ".font-claude-message"],
  ];
  // Leading spaces, no-break spaces and zero-width characters are tolerated.
  const SPACE = "[\\s\\u00a0\\u200b\\u200c\\u200d\\ufeff]";
  const TAG_LINE = new RegExp(`^${SPACE}*Run tag:${SPACE}*([a-z0-9_]+-[a-z0-9]+-s\\d+[a-z]?-[a-z0-9]{4})${SPACE}*$`);
  const CHECK_MS = 1000;
  const SETTLE_MS = 1000;

  /** "unknown" unless the message box and the stop/send area are both found. */
  function decideState({ composer, stop, send, streaming }) {
    if (!composer || !(stop || send)) return "unknown";
    return stop || streaming ? "responding" : "finished";
  }

  const WINDOW_LINE = new RegExp(`^${SPACE}*Window:`, "i");

  /**
   * The tag of the last CLI prompt header: a "Run tag:" line whose next
   * non-blank line starts "Window:". A tag quoted anywhere else is not a prompt.
   */
  function extractTag(text) {
    const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.replace(new RegExp(SPACE, "g"), ""));
    let tag = null;
    lines.forEach((line, i) => {
      const m = TAG_LINE.exec(line);
      if (m && WINDOW_LINE.test(lines[i + 1] ?? "")) tag = m[1];
    });
    return tag;
  }

  /** Claude's latest message: { el, by } with `by` the matching selector's name, or el null and by "none". */
  function latestMessage(root) {
    for (const [name, selector] of MESSAGE_SELECTORS) {
      const outer = [...root.querySelectorAll(selector)].filter((el) => !el.parentElement?.closest(selector));
      if (outer.length) return { el: outer[outer.length - 1], by: name };
    }
    return { el: null, by: "none" };
  }

  /**
   * The issued tag in Claude's latest message, or null. The whole message is
   * read, then each code block on its own, since a block's text keeps its line breaks.
   */
  function readTag(root) {
    const { el } = latestMessage(root);
    if (!el) return null;
    let issuedTag = extractTag(el.innerText ?? el.textContent ?? "");
    for (const block of el.querySelectorAll("pre")) issuedTag = extractTag(block.textContent ?? "") ?? issuedTag;
    return issuedTag;
  }

  /**
   * The last whole CLI prompt in `text`: { tag, text } from its header line to the
   * closing "Run tag:" line with the same tag, or null. No closing line, no prompt.
   */
  function extractPrompt(text) {
    const lines = String(text ?? "").split(/\r?\n/);
    const blank = (l) => !l.replace(new RegExp(SPACE, "g"), "");
    let found = null;
    lines.forEach((line, i) => {
      const m = TAG_LINE.exec(line);
      if (!m) return;
      const next = lines.slice(i + 1).find((l) => !blank(l));
      if (!WINDOW_LINE.test(next ?? "")) return;
      const end = lines.findIndex((l, j) => j > i && TAG_LINE.exec(l)?.[1] === m[1]);
      if (end !== -1) found = { tag: m[1], text: lines.slice(i, end + 1).map((l) => l.replace(/\s+$/, "")).join("\n") };
    });
    return found;
  }

  /** The last whole prompt in one message element, code blocks first, or null. */
  function readPromptIn(el) {
    let prompt = null;
    for (const block of el.querySelectorAll("pre")) prompt = extractPrompt(block.textContent ?? "") ?? prompt;
    return prompt ?? extractPrompt(el.innerText ?? el.textContent ?? "");
  }

  /** The last whole prompt in Claude's latest message, or null. */
  function readPrompt(root) {
    const { el } = latestMessage(root);
    return el ? readPromptIn(el) : null;
  }

  const TAG_SHAPE = /^[a-z0-9_]+-[a-z0-9]+-s\d+[a-z]?-[a-z0-9]{4}$/;

  /** A Send link's run tag, or null. Same rule as lib/bridge-core.js sendTagOf; the tests hold them equal. */
  function sendTagOf(href, hosts) {
    let u;
    try {
      u = new URL(String(href));
    } catch {
      return null;
    }
    if (u.protocol !== "https:" || !hosts.includes(u.host.toLowerCase())) return null;
    const m = /^\/send\/([^/]+)\/?$/.exec(u.pathname);
    return m && TAG_SHAPE.test(m[1]) ? m[1] : null;
  }

  /**
   * The prompt a Send link sends: the whole prompt in the link's own reply, which
   * must be the latest reply carrying one, with the link's tag. { prompt, error }.
   */
  function promptForLink(anchor, tag) {
    const root = anchor.ownerDocument;
    let replies = [], reply = null;
    for (const [, selector] of MESSAGE_SELECTORS) {
      replies = [...root.querySelectorAll(selector)].filter((el) => !el.parentElement?.closest(selector));
      reply = replies.find((el) => el.contains(anchor)) ?? null;
      if (reply) break;
    }
    const refuse = (error) => ({ prompt: null, error });
    if (!reply) return refuse("the link is not in a Claude reply");
    const latest = [...replies].reverse().find((el) => readPromptIn(el));
    const prompt = readPromptIn(reply);
    if (latest && latest !== reply && replies.indexOf(reply) < replies.indexOf(latest)) return refuse("the link is in an older reply");
    if (!prompt) return refuse("no whole CLI prompt in the link's reply");
    if (prompt.tag !== tag) return refuse(`the link is for ${tag}, the prompt is ${prompt.tag}`);
    return { prompt, error: null };
  }

  /** Capture-phase click: stop a listed Send link before navigation and hand it on. True if it was one. */
  function onLinkClick(event, hosts, handle) {
    if (event.button > 1) return false;
    const anchor = event.target?.closest?.("a[href]");
    const tag = anchor ? sendTagOf(anchor.href, hosts) : null;
    if (!tag) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    handle(anchor, tag);
    return true;
  }

  /** Put the cursor at the end of the message box. Types nothing, reads nothing. True if found. */
  function focusComposer(root) {
    const el = root.querySelector(SELECTORS.composer);
    if (!el) return false;
    el.focus();
    try {
      const sel = root.defaultView?.getSelection();
      const range = root.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch { /* focus alone is enough */ }
    return true;
  }

  /** What Send cli may do, from the page as it is now: "send", "type" (Claude is writing) or "focus". */
  function cliPlan(state, composerEmpty) {
    if (state === "unknown" || composerEmpty !== true) return "focus";
    return state === "responding" ? "type" : "send";
  }

  /**
   * Send cli, decided on the live page: focus the box, and type "cli" and press
   * send only when the box is empty. Reads only whether the box is empty.
   * Resolves to "sent", "typed" or "focused".
   */
  async function sendCli(root) {
    const q = (s) => root.querySelector(s);
    const box = q(SELECTORS.composer);
    const state = decideState({ composer: !!box, stop: !!q(SELECTORS.stop), send: !!q(SELECTORS.send), streaming: !!q(SELECTORS.streaming) });
    const plan = cliPlan(state, box ? box.innerText.trim() === "" : null);
    focusComposer(root);
    if (plan === "focus") return "focused";
    root.execCommand("insertText", false, "cli");
    if (plan === "type") return "typed";
    // The send button enables a moment after the box has text.
    for (let i = 0; i < 30; i++) {
      const button = q(SELECTORS.send);
      if (button && !button.disabled) {
        button.click();
        return "sent";
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return "typed";
  }

  const isChatPath = (pathname) => /^\/chat\/[^/]+/.test(pathname);
  const normalise = (url) => String(url).split(/[?#]/)[0];

  globalThis.__alfredWatchCore = {
    decideState, extractTag, extractPrompt, isChatPath, latestMessage, readTag, readPrompt, readPromptIn, sendTagOf,
    promptForLink, onLinkClick, focusComposer, cliPlan, sendCli, SELECTORS,
  };
  if (typeof chrome === "undefined" || !chrome.runtime?.id || typeof document === "undefined") return;

  // A re-injection (bridge.js, after an extension reload) replaces the old watcher.
  try { globalThis.__alfredWatchStop?.(); } catch { /* old context gone */ }

  let reported = null;        // the last report sent, as JSON
  let shown = null;           // the state last reported
  let since = new Date().toISOString();
  let pending = null, pendingAt = 0;
  let timer = null, observer = null, beat = null, hrefPoll = null;
  const cleanups = [];

  function probe() {
    const q = (s) => document.querySelector(s);
    const composerEl = q(SELECTORS.composer);
    const state = decideState({
      composer: !!composerEl, stop: !!q(SELECTORS.stop), send: !!q(SELECTORS.send), streaming: !!q(SELECTORS.streaming),
    });
    // Tags are read only from a finished message, so a half-written one is never sent.
    const issuedTag = state === "finished" ? readTag(document) : null;
    return { state, issuedTag, composerEmpty: composerEl ? composerEl.innerText.trim() === "" : null };
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(beat);
    clearInterval(hrefPoll);
    observer?.disconnect();
    for (const undo of cleanups.splice(0)) try { undo(); } catch { /* context gone */ }
  }

  function send(report) {
    try {
      if (!chrome.runtime?.id) return stop();   // the extension was reloaded
      chrome.runtime.sendMessage({ type: "chat-state", chat: report }).catch(() => {});
    } catch {
      stop();
    }
  }

  function check() {
    timer = null;
    try {
      if (!isChatPath(location.pathname)) {
        if (reported !== "gone") send(null), (reported = "gone"), (shown = null);
        return;
      }
      const p = probe();
      // Responding and unknown show at once; finished only once it has held for SETTLE_MS.
      if (p.state === "finished" && shown !== "finished") {
        if (pending !== "finished") pending = "finished", pendingAt = Date.now();
        if (Date.now() - pendingAt < SETTLE_MS) return schedule(SETTLE_MS);
      }
      pending = null;
      if (p.state !== shown) shown = p.state, since = new Date().toISOString();
      const report = {
        url: normalise(location.href), title: document.title, state: shown, since,
        issuedTag: p.issuedTag, composerEmpty: p.composerEmpty,
      };
      const json = JSON.stringify(report);
      if (json !== reported) send(report), (reported = json);
    } catch {
      // A page we cannot read is never a finish.
    }
  }

  function schedule(ms = CHECK_MS) {
    if (!timer) timer = setTimeout(check, ms);
  }

  observer = new MutationObserver(() => schedule());
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["aria-label", "data-is-streaming", "disabled"] });
  // claude.ai moves a new chat from /new to /chat/<id> in place, with no page
  // load: check at once on any address change, from whichever signal comes first.
  let lastHref = location.href;
  const onAddress = () => {
    if (location.href !== lastHref) lastHref = location.href, clearTimeout(timer), (timer = null), schedule(0);
  };
  hrefPoll = setInterval(onAddress, 500);
  try {
    globalThis.navigation?.addEventListener("currententrychange", onAddress);
    cleanups.push(() => globalThis.navigation?.removeEventListener("currententrychange", onAddress));
  } catch { /* no Navigation API */ }
  // Send links: the host list arrives from bridge.js; with none, no link is caught.
  let linkHosts = [];
  const say = (...a) => console.info("[Alfred watch]", ...a);
  const sendLink = (anchor, tag) => {
    const r = probe().state === "responding" ? { prompt: null, error: "Claude is still writing" } : promptForLink(anchor, tag);
    say(`Send ${tag}:`, r.error ?? "prompt found, handed to the bridge");
    try {
      chrome.runtime.sendMessage({ type: "send-prompt", tag, prompt: r.prompt, error: r.error }).catch(() => {});
    } catch {
      stop();
    }
  };
  // Says why a /send/ link was let through, since that only shows in Chrome.
  const onClick = (e) => {
    if (onLinkClick(e, linkHosts, sendLink)) return;
    const a = e.target?.closest?.("a[href]");
    if (a && /\/send\//.test(a.href)) say("Send link not caught:", a.href, linkHosts.length ? `host not in [${linkHosts}]` : "no link hosts from the bridge");
  };
  const setHosts = (hosts) => { linkHosts = hosts; say("link hosts:", hosts.join(", ") || "(none)"); };
  for (const type of ["click", "auxclick"]) {
    document.addEventListener(type, onClick, true);
    cleanups.push(() => document.removeEventListener(type, onClick, true));
  }
  try {
    chrome.runtime.sendMessage({ type: "link-hosts?" }).then((r) => { if (Array.isArray(r?.hosts)) setHosts(r.hosts); }, () => {});
  } catch { /* old context */ }

  const onNudge = (msg, _sender, reply) => {
    if (msg?.type === "watch-recheck") onAddress(), schedule(0);
    if (msg?.type === "focus-composer") focusComposer(document);
    if (msg?.type === "link-hosts" && Array.isArray(msg.hosts)) setHosts(msg.hosts);
    if (msg?.type === "send-link" && typeof msg.tag === "string") {
      // The backup: a /send/ tab opened anyway. Act on the last link with that tag.
      const anchors = [...document.querySelectorAll("a[href]")].filter((a) => sendTagOf(a.href, linkHosts) === msg.tag);
      if (anchors.length) sendLink(anchors[anchors.length - 1], msg.tag);
    }
    if (msg?.type === "send-cli") {
      sendCli(document).then((did) => reply({ did }), () => reply({ did: "focused" }));
      return true;    // answers asynchronously
    }
    return false;
  };
  try {
    chrome.runtime.onMessage.addListener(onNudge);
    cleanups.push(() => chrome.runtime.onMessage.removeListener(onNudge));
  } catch { /* old context */ }
  // A title change and some state changes do not always mutate what is observed.
  beat = setInterval(() => schedule(0), 5000);
  globalThis.__alfredWatchStop = stop;
  schedule(0);
})();
