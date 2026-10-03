// Switchboard bridge: watches one claude.ai chat and tells the service worker
// (bridge.js) whether Claude is responding. Spec:
// docs/technical-spec-switchboard_bridge.md, section 3, "claude.ai watcher".
//
// 🛑 NO CHAT TEXT LEAVES THIS PAGE. Each report carries the address, the title,
// the state, when it last changed, the last run tag in Claude's latest message
// (only lines that begin "Run tag:", only the tag) and whether the message box
// is empty. Never the box's text, and never any message text.
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

  /** The last whole run tag on a line of its own beginning "Run tag:", or null. */
  function extractTag(text) {
    let tag = null;
    for (const line of String(text ?? "").split(/\r?\n/)) {
      const m = TAG_LINE.exec(line);
      if (m) tag = m[1];
    }
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
    decideState, extractTag, isChatPath, latestMessage, readTag, focusComposer, cliPlan, sendCli, SELECTORS,
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
  const onNudge = (msg, _sender, reply) => {
    if (msg?.type === "watch-recheck") onAddress(), schedule(0);
    if (msg?.type === "focus-composer") focusComposer(document);
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
