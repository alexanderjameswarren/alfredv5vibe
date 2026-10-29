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
