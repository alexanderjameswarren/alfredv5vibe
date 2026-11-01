// Pure logic for the Switchboard bridge (bridge.js): no Chrome APIs, so it runs
// under node. Spec: docs/history/technical-spec-switchboard_bridge.md, section 3.
// BRIDGE HALF: imported by bridge.js only.

export const HOST_NAME = "com.alfred.switchboard";
export const HEARTBEAT_MS = 15000;
export const DEBOUNCE_MS = 500;
export const FIRST_RETRY_MS = 1000;
export const MAX_RETRY_MS = 60000;

/** The address without its query or fragment; anything unparseable comes back unchanged. */
export function normaliseUrl(url) {
  return typeof url === "string" ? url.split(/[?#]/)[0] : "";
}

/** The `tabs` message for the host, from tabs.query({}) and windows.getAll(). */
export function buildTabsMessage(tabs = [], windows = []) {
  const focused = new Set(windows.filter((w) => w.focused).map((w) => w.id));
  return {
    type: "tabs",
    tabs: tabs.map((t) => ({
      tabId: t.id,
      windowId: t.windowId,
      index: t.index,
      active: !!t.active,
      windowFocused: focused.has(t.windowId),
      title: t.title ?? "",
      url: normaliseUrl(t.url ?? t.pendingUrl ?? ""),
      discarded: !!t.discarded,
    })),
  };
}

/** The tab a focus command names: by tabId, or the first tab whose address matches its url. */
export function pickTab(cmd, tabs = []) {
  if (Number.isInteger(cmd?.tabId)) return tabs.find((t) => t.id === cmd.tabId) ?? null;
  if (typeof cmd?.url === "string") {
    const want = normaliseUrl(cmd.url);
    return tabs.find((t) => normaliseUrl(t.url ?? t.pendingUrl ?? "") === want) ?? null;
  }
  return null;
}

/** The reply for the host. A Chrome window's title is its active tab's title plus " - Google Chrome". */
export function focusResult(id, tab, error, did = "focused") {
  return tab && !error
    ? { type: "result", id, ok: true, windowTitle: tab.title ?? "", did, error: null }
    : { type: "result", id, ok: false, windowTitle: null, did: null, error: error ?? "no such tab" };
}

const CHAT_URL = /^https:\/\/claude\.ai\/chat\/[^/?#]+/;

/**
 * The `chats` message: every open claude.ai chat tab, with its watcher's last
 * report. A tab that has not reported, or is discarded, is unknown.
 * `reports` and `viewedAt` are Maps keyed by tabId.
 */
export function buildChatsMessage(tabs = [], windows = [], reports = new Map(), viewedAt = new Map(), now = new Date()) {
  const focused = new Set(windows.filter((w) => w.focused).map((w) => w.id));
  const chats = [];
  for (const t of tabs) {
    const url = normaliseUrl(t.url ?? t.pendingUrl ?? "");
    if (!CHAT_URL.test(url)) continue;
    const r = reports.get(t.id);
    const fresh = r && normaliseUrl(r.url) === url && !t.discarded;
    const viewing = t.active && focused.has(t.windowId);
    chats.push({
      tabId: t.id,
      windowId: t.windowId,
      url,
      title: t.title ?? "",
      state: fresh ? r.state : "unknown",
      since: fresh ? r.since ?? null : null,
      issuedTag: fresh ? r.issuedTag ?? null : null,
      composerEmpty: fresh ? r.composerEmpty ?? null : null,
      viewedAt: viewing ? now.toISOString() : viewedAt.get(t.id) ?? null,
    });
  }
  return { type: "chats", chats };
}

// ---------------------------------------------------------------------------
// Send to CLI by a link in the reply (switchboard2-h8r 1.1-1.2, spec 7.1)
// ---------------------------------------------------------------------------

const TAG_SHAPE = /^[a-z0-9_]+-[a-z0-9]+-s\d+[a-z]?-[a-z0-9]{4}$/;
const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

/** A run tag's project code: everything before the step segment. Null for a non-tag. */
export function projectOfTag(tag) {
  return /^([a-z0-9_]+-[a-z0-9]+)-s\d+[a-z]?-[a-z0-9]{4}$/.exec(String(tag ?? ""))?.[1] ?? null;
}

/** The host list from the host's hello: lower-case host names only, anything else dropped. */
export function cleanHosts(list) {
  return (Array.isArray(list) ? list : [])
    .filter((h) => typeof h === "string")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOST_SHAPE.test(h));
}

/**
 * The run tag of a Send link: https, a host exactly in `hosts`, path /send/<tag>.
 * Null otherwise. claude-watch.js has a copy (it cannot import); the tests hold them equal.
 */
export function sendTagOf(href, hosts) {
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
 * Why the reply's prompt may not go, or null. `cmd.tag`: the link's tag.
 * `cmd.project` and `cmd.sentTag` are checked only when given.
 */
export function checkPrompt(cmd, prompt) {
  if (!prompt?.tag) return "no whole CLI prompt in the link's reply";
  const project = projectOfTag(prompt.tag);
  if (cmd.project && project !== cmd.project) return `the prompt is for ${project}, not ${cmd.project}`;
  if (cmd.tag !== prompt.tag) return `the link is for ${cmd.tag}, the prompt is ${prompt.tag}`;
  if (cmd.sentTag && cmd.sentTag === prompt.tag) return `${prompt.tag} was already sent`;
  return null;
}

/** The frame for the host. The text travels only when the prompt passed. */
export function promptFrame(id, tag, prompt, error) {
  return error ? { type: "prompt", id, tag, error } : { type: "prompt", id, tag, text: prompt.text };
}

// ---------------------------------------------------------------------------
// The approval result (switchboard2-h8r 2.7, spec 8.1)
// ---------------------------------------------------------------------------

const RUN_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_SHAPE = /^[a-z0-9_-]{1,40}$/;

/**
 * The token of an approval link: https, a host exactly in `hosts`, path /approve/<token>.
 * Null otherwise. claude-watch.js has a copy (it cannot import); the tests hold them equal.
 */
export function approveTokenOf(href, hosts) {
  let u;
  try {
    u = new URL(String(href));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !hosts.includes(u.host.toLowerCase())) return null;
  return /^\/approve\/([^/]+)\/?$/.exec(u.pathname)?.[1] ?? null;
}

export const isApprovePage = (href, hosts) => approveTokenOf(href, hosts) !== null;

export const GRANT_BADGE = "SITE";

/** The Chrome match patterns for listed hosts. A pattern needs no port to cover one. */
export function hostOrigins(hosts) {
  return hosts.map((h) => `https://${h.split(":")[0]}/*`);
}

/** What the toolbar icon says while a listed host is not allowed, or null. */
export function grantNotice(missing) {
  if (!missing.length) return null;
  return {
    badge: GRANT_BADGE,
    title: `Alfred's Clipboard can't read ${missing.join(", ")}, so approval results won't reach the chat. ` +
      `Right-click this icon, choose "Allow Alfred's sites", then reload the approval page.`,
  };
}

/** Close the approval tab only once the line is really sent, and only if that tab still shows an approval page. */
export const closesApproveTab = (did, tabUrl, hosts) => did === "sent" && isApprovePage(tabUrl, hosts);

/** Only a well-formed run id and project from a page's message go any further. */
export function cleanRun(msg) {
  return RUN_ID_SHAPE.test(msg?.runId ?? "") && PROJECT_SHAPE.test(msg?.project ?? "") ? { runId: msg.runId, project: msg.project } : null;
}

/**
 * The one open chat for a project: { chat, why }. The chat whose latest reply issued
 * the project's run tag comes first, then the title, as the panel's mapping does.
 * More than one match posts nothing rather than guess.
 */
export function chatForProject(chats, project) {
  const issued = chats.filter((c) => projectOfTag(c.issuedTag) === project);
  const code = new RegExp(`(^|[^a-z0-9_-])${project.replace(/[^a-z0-9_-]/g, "")}($|[^a-z0-9_-])`, "i");
  const found = issued.length ? issued : chats.filter((c) => code.test(c.title ?? ""));
  if (found.length === 1) return { chat: found[0], why: null };
  return { chat: null, why: found.length ? `${found.length} chats match ${project}` : `no open chat for ${project}` };
}

/**
 * The chat for a run: the tab its link was clicked in, while that tab still shows the
 * same chat. Links opened elsewhere (the phone) fall back to chatForProject.
 */
export function chatForRun(chats, run) {
  const clicked = run.from && chats.find((c) => c.tabId === run.from.tabId && c.url === run.from.url);
  return clicked ? { chat: clicked, why: null } : chatForProject(chats, run.project);
}

/** Why "sql <run id>" didn't go into this chat, in plain words, or null. `did`: the watcher's answer. */
export function postProblem(chat, why, did) {
  if (!chat) return why ?? "no open chat was found";
  if (did === "clear" || did === "sent") return null;
  if (did === "writing") return "Claude is still writing in that chat";
  if (did === "box") return "that chat's message box isn't empty: it has text, an image, a file or something else waiting to send";
  if (did === "unknown") return "the extension can't read that chat's page";
  if (did === "unsent") return "that chat's Send button didn't take it, so the line was taken back out";
  return "that chat's tab didn't answer";
}

const CLICK_KEEP_MS = 60 * 60 * 1000;
const SEEN_KEEP_MS = 24 * 60 * 60 * 1000;
const fresh = (obj, keep, now) => Object.fromEntries(Object.entries(obj).filter(([, v]) => now - (v?.at ?? v) <= keep));
const isMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The stored approval state, with old entries gone. Whatever was stored wrongly reads as empty. */
export function pruneApprovals(state, now = Date.now()) {
  return {
    hosts: Array.isArray(state?.hosts) ? state.hosts : [],
    clicks: fresh(isMap(state?.clicks) ? state.clicks : {}, CLICK_KEEP_MS, now),
    runs: (Array.isArray(state?.runs) ? state.runs : []).filter((r) => now - r.at <= SEEN_KEEP_MS),
    seen: fresh(isMap(state?.seen) ? state.seen : {}, SEEN_KEEP_MS, now),
  };
}

/**
 * Injected into the approval page: says why the chat didn't get the result, in the status element the
 * page reserves, and wires its Try again. Adds no markup or styling. False if the page has no such element.
 */
export function approveStatus(text, runId) {
  const status = document.querySelector("[data-switchboard-status]");
  const words = status?.querySelector("[data-switchboard-status-text]");
  const again = status?.querySelector("[data-switchboard-retry]");
  if (!words || !again) return false;
  words.textContent = text;
  status.hidden = false;
  again.hidden = false;
  // Assigned, not added: a second fill or a re-injection replaces the last one.
  again.onclick = () => {
    words.textContent = "Trying again…";
    again.hidden = true;
    chrome.runtime.sendMessage({ type: "approve-retry", runId }).catch(() => {});
  };
  return true;
}

/**
 * Injected into the approval page by bridge.js, so it must stand alone. Waits for
 * the run id only a real run puts on the page, and hands it over with the page's
 * project code. A new injection replaces the last, which an extension reload left dead.
 */
export function approveWatcher() {
  document.__alfredApproveWatch?.disconnect?.();
  const check = () => {
    const runId = document.querySelector("[data-switchboard-run-id]")?.getAttribute("data-switchboard-run-id");
    if (!runId) return false;
    const project = document.querySelector("[data-switchboard-project]")?.getAttribute("data-switchboard-project");
    chrome.runtime.sendMessage({ type: "approve-run", runId, project }).catch(() => {});
    return true;
  };
  if (check()) return;
  const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
  document.__alfredApproveWatch = observer;
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-switchboard-run-id"] });
}

/** Next reconnect delay: 1 s, doubling, capped at 60 s. */
export const nextDelay = (prev) => (prev ? Math.min(prev * 2, MAX_RETRY_MS) : FIRST_RETRY_MS);

/**
 * Errors that mean this machine has no usable host (the Surface, the Chromebook,
 * or an id missing from allowed_origins). Retrying cannot fix them.
 */
export function isHostMissing(message) {
  return /native messaging host not found|forbidden/i.test(String(message ?? ""));
}

/** Calls fn once, `ms` after the last of a burst of calls. */
export function debounce(fn, ms, timers = globalThis) {
  let handle = null;
  return () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      handle = null;
      fn();
    }, ms);
  };
}
