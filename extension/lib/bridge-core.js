// Pure logic for the Switchboard bridge (bridge.js): no Chrome APIs, so it runs
// under node. Spec: docs/technical-spec-switchboard_bridge.md, section 3.

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
