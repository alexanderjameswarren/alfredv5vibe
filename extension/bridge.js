// Switchboard bridge: sends this browser's tab list to the native host
// (tools/claude-sessions/bridge), which writes it where the Switchboard panel
// reads it. Spec: docs/history/technical-spec-switchboard_bridge.md, section 3.
//
// BRIDGE HALF, with claude-watch.js and lib/bridge-core.js. It imports only
// bridge files, and the clipper reaches it only through service-worker.js's
// `import "./bridge.js"` (lib/boundaries.test.mjs).
//
// 🛑 NOTHING HERE MAY BREAK CLIPPING. service-worker.js imports this file, so a
// throw at the top level would stop the worker loading. Every Chrome call is
// wrapped, every failure is swallowed, and on a machine with no host (the
// Surface, the Chromebook) it gives up quietly until the worker next starts.

import {
  HOST_NAME, HEARTBEAT_MS, DEBOUNCE_MS, buildTabsMessage, buildChatsMessage, nextDelay, isHostMissing, debounce,
  normaliseUrl, pickTab, focusResult, checkPrompt, cleanHosts, promptFrame, sendTagOf,
  approveTokenOf, approveWatcher, chatForRun, cleanRun, closesApproveTab, GRANT_BADGE, grantNotice, hostOrigins, isApprovePage, RUN_POST_MS,
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
    postRuns();
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

// Send links (spec 7.1): the hosts come only from the host's hello, never from code.
let linkHosts = [];
let promptSeq = 0;

async function broadcastHosts() {
  try {
    for (const tab of await chrome.tabs.query({ url: "https://claude.ai/*" })) {
      chrome.tabs.sendMessage(tab.id, { type: "link-hosts", hosts: linkHosts }).catch(() => {});
    }
  } catch (e) {
    quiet(e);
  }
}

// A watcher caught a Send link click: check again and hand the prompt to the host.
function onSendPrompt(msg, sender) {
  try {
    if (sender?.id !== chrome.runtime.id || !String(sender?.url ?? "").startsWith("https://claude.ai/")) return;
    if (typeof msg.tag !== "string") return;
    const error = typeof msg.error === "string" ? msg.error : checkPrompt({ tag: msg.tag }, msg.prompt);
    port?.postMessage(promptFrame(`ext-${Date.now().toString(36)}-${++promptSeq}`, msg.tag, msg.prompt, error));
  } catch (e) {
    quiet(e);
  }
}

// The backup: a /send/ tab opened from claude.ai anyway (the click was not caught).
// Close it and let the opener's watcher handle the link as if it had been.
async function onSendTab(tab, url) {
  try {
    const tag = sendTagOf(url, linkHosts);
    if (/\/send\//.test(String(url ?? "")) && (!tag || !Number.isInteger(tab?.openerTabId))) {
      console.info("[Alfred bridge] /send/ tab left open:", url, !tag ? `host not in [${linkHosts}]` : "no opener tab");
    }
    if (!tag || !Number.isInteger(tab?.openerTabId)) return;
    const opener = await chrome.tabs.get(tab.openerTabId);
    if (!String(opener?.url ?? "").startsWith("https://claude.ai/")) return;
    await chrome.tabs.remove(tab.id);
    chrome.tabs.sendMessage(opener.id, { type: "send-link", tag }).catch(() => {});
  } catch (e) {
    quiet(e);
  }
}

// Reading an approval page needs its host allowed at run time, from a click (spec §2, rule 8).
// The click is the "Allow Alfred's sites" item service-worker.js puts on the toolbar icon.
const allowed = (host) => chrome.permissions.contains({ origins: hostOrigins([host]) });

async function showGrant() {
  try {
    const missing = [];
    for (const h of linkHosts) if (!(await allowed(h))) missing.push(h);
    const notice = grantNotice(missing);
    const badge = await chrome.action.getBadgeText({});
    // Never over the clipper's own badge; the next heartbeat tries again.
    if (notice && badge === "") {
      console.info("[Alfred bridge]", notice.title);
      await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
      await chrome.action.setBadgeText({ text: notice.badge });
      await chrome.action.setTitle({ title: notice.title });
    }
    if (!notice && badge === GRANT_BADGE) {
      await chrome.action.setBadgeText({ text: "" });
      await chrome.action.setTitle({ title: chrome.runtime.getManifest().action.default_title });
    }
  } catch (e) {
    quiet(e);
  }
}

function grantSay(text) {
  console.info("[Alfred bridge]", text);
  chrome.action.setTitle({ title: `Alfred's Clipboard: ${text}` }).catch(quiet);
}

// No await before the request: Chrome only allows it during the click.
function grantHosts() {
  if (!linkHosts.length) return grantSay("no site list from the panel yet, so nothing to allow. Is the Switchboard panel installed?");
  chrome.permissions.request({ origins: hostOrigins(linkHosts) }).then(
    (granted) => { if (!granted) grantSay("the sites were not allowed."); showGrant(); },
    (e) => grantSay(`Chrome refused to ask: ${e?.message ?? e}`),
  );
}

// The approval result (spec 8.1): an approval page on a listed host reports its run id,
// and "sql <run id>" goes to the tab its link was clicked in, once that chat is idle.
const seenRuns = new Set();
let waitingRuns = [];   // { runId, project, from, approveTabId, at }
let posting = false;
const clickedChats = new Map();   // approval token -> { tabId, url, at }

// A watcher saw an approval link clicked. The link opens as usual.
function onApproveClick(msg, sender) {
  try {
    const tabId = sender?.tab?.id;
    const url = normaliseUrl(sender?.tab?.url);
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(tabId) || !url.startsWith("https://claude.ai/")) return;
    const token = approveTokenOf(msg.href, linkHosts);
    if (!token) return;
    // Links last 30 minutes; these are only kept a little longer.
    for (const [t, c] of clickedChats) if (Date.now() - c.at > 2 * 30 * 60 * 1000) clickedChats.delete(t);
    clickedChats.set(token, { tabId, url, at: Date.now() });
  } catch (e) {
    quiet(e);
  }
}

async function watchApprovePage(tabId, url) {
  try {
    if (!isApprovePage(url, linkHosts)) return;
    if (await allowed(new URL(url).host)) {
      await chrome.scripting.executeScript({ target: { tabId }, func: approveWatcher });
      return;
    }
    const notice = grantNotice([new URL(url).host]);
    console.info("[Alfred bridge]", notice.title);
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d97706" });
    await chrome.action.setBadgeText({ tabId, text: notice.badge });
    await chrome.action.setTitle({ tabId, title: notice.title });
  } catch (e) {
    quiet(e);
  }
}

function onApproveRun(msg, sender) {
  try {
    const token = sender?.id === chrome.runtime.id ? approveTokenOf(sender?.url, linkHosts) : null;
    if (!token) return;
    const run = cleanRun(msg);
    if (!run || seenRuns.has(run.runId)) return;
    seenRuns.add(run.runId);
    waitingRuns.push({ ...run, from: clickedChats.get(token), approveTabId: sender.tab?.id, at: Date.now() });
    clickedChats.delete(token);
    postRuns();
  } catch (e) {
    quiet(e);
  }
}

async function postRuns() {
  if (posting || !waitingRuns.length) return;
  posting = true;
  try {
    const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
    const { chats } = buildChatsMessage(tabs, windows, reports, viewedAt);
    for (const run of [...waitingRuns]) {
      const { chat, why } = chatForRun(chats, run);
      const late = Date.now() - run.at > RUN_POST_MS;
      if (late) {
        console.info("[Alfred bridge] sql result not posted:", run.runId, why ?? "the chat never went idle");
        waitingRuns = waitingRuns.filter((r) => r !== run);
      }
      if (late || !chat || chat.state !== "finished" || chat.composerEmpty !== true) continue;
      // Typing into the box needs its tab showing, as Send cli does.
      await chrome.tabs.update(chat.tabId, { active: true });
      await chrome.windows.update(chat.windowId, { focused: true });
      const answer = await chrome.tabs.sendMessage(chat.tabId, { type: "post-line", text: `sql ${run.runId}` }).catch(() => null);
      if (answer?.did === "sent" || answer?.did === "typed") waitingRuns = waitingRuns.filter((r) => r !== run);
      if (Number.isInteger(run.approveTabId)) {
        // Alex may have closed it already; then there is nothing to do.
        const page = await chrome.tabs.get(run.approveTabId).catch(() => null);
        if (closesApproveTab(answer?.did, page?.url, linkHosts)) await chrome.tabs.remove(run.approveTabId).catch(quiet);
      }
    }
  } catch (e) {
    quiet(e);
  } finally {
    posting = false;
  }
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
  // No host, no Send: links open Alfred's page instead of being caught and dropped.
  if (linkHosts.length) linkHosts = [], broadcastHosts();
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
        linkHosts = cleanHosts(msg.linkHosts);
        console.info("[Alfred bridge] link hosts from the host:", linkHosts.join(", ") || "(none)");
        sendTabs();
        injectWatchers();
        broadcastHosts();
        showGrant();
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
  chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
    if (port && change.url?.startsWith("https://claude.ai/")) {
      chrome.tabs.sendMessage(tabId, { type: "watch-recheck" }).catch(() => {});
    }
    if (port && change.url) onSendTab(tab, change.url);
    if (port && change.status === "complete") watchApprovePage(tabId, tab.url);
  });
  chrome.tabs.onCreated?.addListener((tab) => { if (port) onSendTab(tab, tab.pendingUrl ?? tab.url); });
  // Returns false: any reply is sent at once, so Chrome holds no channel open (as service-worker.js does).
  chrome.runtime.onMessage?.addListener((msg, sender, reply) => {
    if (msg?.type === "chat-state") onWatchReport(msg, sender);
    if (msg?.type === "send-prompt") onSendPrompt(msg, sender);
    if (msg?.type === "approve-click") onApproveClick(msg, sender);
    if (msg?.type === "approve-run") onApproveRun(msg, sender);
    if (msg?.type === "link-hosts?") reply({ hosts: linkHosts });
    return false;
  });
  chrome.contextMenus?.onClicked.addListener((info) => { if (info.menuItemId === "allow-alfred-sites") grantHosts(); });
  chrome.permissions?.onRemoved.addListener(showGrant);
  // An open native port keeps the worker alive, so this keeps running while connected.
  setInterval(() => { if (port) sendTabs(), postRuns(), showGrant(); }, HEARTBEAT_MS);
  connect();
} catch (e) {
  quiet(e);
}
