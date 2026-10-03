// Switchboard bridge: sends this browser's tab list to the native host
// (tools/claude-sessions/bridge), which writes it where the Switchboard panel
// reads it. Spec: docs/technical-spec-switchboard_bridge.md, section 3.
//
// 🛑 NOTHING HERE MAY BREAK CLIPPING. service-worker.js imports this file, so a
// throw at the top level would stop the worker loading. Every Chrome call is
// wrapped, every failure is swallowed, and on a machine with no host (the
// Surface, the Chromebook) it gives up quietly until the worker next starts.

import {
  HOST_NAME, HEARTBEAT_MS, DEBOUNCE_MS, buildTabsMessage, buildChatsMessage, nextDelay, isHostMissing, debounce,
  pickTab, focusResult,
} from "./lib/bridge-core.js";

let port = null;
let gaveUp = false;
let retryMs = 0;
let retryTimer = null;
const reports = new Map();    // tabId -> claude-watch.js's last report
const viewedAt = new Map();   // tabId -> when it was last the active tab of the focused window

const quiet = (e) => console.debug("[Alfred bridge]", e?.message ?? e);

// Both lists go together: a chat's viewedAt and unknown state depend on the tabs.
async function sendTabs() {
  try {
    if (!port) return;
    const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
    port?.postMessage(buildTabsMessage(tabs, windows));
    const chats = buildChatsMessage(tabs, windows, reports, viewedAt);
    for (const c of chats.chats) if (c.viewedAt) viewedAt.set(c.tabId, c.viewedAt);
    port?.postMessage(chats);
  } catch (e) {
    quiet(e);
  }
}

// Tabs already open on claude.ai get the watcher too; manifest injection covers new ones.
async function injectWatchers() {
  try {
    for (const tab of await chrome.tabs.query({ url: "https://claude.ai/*" })) {
      if (tab.discarded) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["claude-watch.js"] }).catch(quiet);
    }
  } catch (e) {
    quiet(e);
  }
}

// Only these fields of a watcher's report are kept; nothing else is passed on.
function onWatchReport(msg, sender) {
  try {
    const tabId = sender?.tab?.id;
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(tabId)) return;
    if (!String(sender.url ?? "").startsWith("https://claude.ai/")) return;
    const c = msg.chat;
    if (!c) reports.delete(tabId);
    else {
      reports.set(tabId, {
        url: String(c.url ?? ""), state: String(c.state ?? "unknown"), since: c.since ?? null,
        issuedTag: typeof c.issuedTag === "string" ? c.issuedTag : null,
        composerEmpty: typeof c.composerEmpty === "boolean" ? c.composerEmpty : null,
      });
    }
    if (port) scheduleTabs();
  } catch (e) {
    quiet(e);
  }
}

const scheduleTabs = debounce(sendTabs, DEBOUNCE_MS);

// Make the tab active and its window focused, then answer with the tab's title,
// which the panel uses to find the Chrome window. Windows may refuse Chrome the
// foreground; the panel activates the window itself.
async function focusTab(cmd) {
  let reply;
  try {
    const tab = pickTab(cmd, await chrome.tabs.query({}));
    if (!tab) {
      reply = focusResult(cmd.id, null, cmd.tabId !== undefined ? `no tab with id ${cmd.tabId}` : "no tab with that address");
    } else {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      let did = "focused";
      if (cmd.action === "sendcli") {
        // The watcher decides on the live page whether to send, type or only focus.
        const answer = await chrome.tabs.sendMessage(tab.id, { type: "send-cli" }).catch(() => null);
        did = ["sent", "typed", "focused"].includes(answer?.did) ? answer.did : "focused";
      } else if (cmd.composer === true) {
        // Cursor into the chat's message box; the watcher types nothing.
        chrome.tabs.sendMessage(tab.id, { type: "focus-composer" }).catch(() => {});
      }
      reply = focusResult(cmd.id, await chrome.tabs.get(tab.id), null, did);
    }
  } catch (e) {
    reply = focusResult(cmd.id, null, String(e?.message ?? e).slice(0, 300));
  }
  try { port?.postMessage(reply); } catch (e) { quiet(e); }
}

function onCommand(cmd) {
  if (cmd.action === "focus" || cmd.action === "sendcli") return focusTab(cmd);
  try {
    port?.postMessage(focusResult(cmd.id, null, `unsupported action ${cmd.action}`));
  } catch (e) {
    quiet(e);
  }
}

function onDisconnect() {
  // Reading lastError is what keeps Chrome from logging it as unchecked.
  const message = chrome.runtime.lastError?.message ?? "";
  port = null;
  if (isHostMissing(message)) {
    gaveUp = true;
    quiet(`host unavailable, bridge off until the worker restarts: ${message}`);
    return;
  }
  retryMs = nextDelay(retryMs);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryMs);
}

function connect() {
  if (gaveUp || port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onDisconnect.addListener(onDisconnect);
    port.onMessage.addListener((msg) => {
      if (msg?.type === "hello") {
        retryMs = 0;
        sendTabs();
        injectWatchers();
      }
      if (msg?.type === "command" && typeof msg.id === "string") onCommand(msg);
    });
  } catch (e) {
    port = null;
    gaveUp = true;
    quiet(e);
  }
}

// Listeners are added at the top level, as MV3 requires, and do nothing without a port.
const onChange = () => { if (port) scheduleTabs(); };
try {
  for (const ev of [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated,
    chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced,
    chrome.windows.onCreated, chrome.windows.onRemoved, chrome.windows.onFocusChanged,
  ]) ev?.addListener(onChange);
  chrome.tabs.onRemoved?.addListener((tabId) => { reports.delete(tabId); viewedAt.delete(tabId); });
  // An in-place move from /new to /chat/<id>: nudge the watcher to report at once.
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (port && change.url?.startsWith("https://claude.ai/")) {
      chrome.tabs.sendMessage(tabId, { type: "watch-recheck" }).catch(() => {});
    }
  });
  // Returns false: no reply, so Chrome holds no channel open (as service-worker.js does).
  chrome.runtime.onMessage?.addListener((msg, sender) => {
    if (msg?.type === "chat-state") onWatchReport(msg, sender);
    return false;
  });
  // An open native port keeps the worker alive, so this keeps running while connected.
  setInterval(() => { if (port) sendTabs(); }, HEARTBEAT_MS);
  connect();
} catch (e) {
  quiet(e);
}
