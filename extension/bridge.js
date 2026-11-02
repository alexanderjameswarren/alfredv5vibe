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
  approveLinkInfo, approveStatus, approveTokenOf, approveWatcher, chatForRun, cleanRun, closesApproveTab, GRANT_BADGE, grantNotice, hostOrigins, isApprovePage,
  deliveryMessage, dismissNotPosted, notPostedText, postProblem, pruneApprovals, runLine, withApprovalStates,
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
    port?.postMessage({ ...chats, chats: withApprovalStates(chats.chats, approvals) });
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
      // A new turn in that chat means a line that couldn't post has been dealt with.
      if (dismissNotPosted(approvals, tabId, reports.get(tabId)?.state, c.state)) saveApprovals();
      reports.set(tabId, {
        url: String(c.url ?? ""), state: String(c.state ?? "unknown"), since: c.since ?? null,
        issuedTag: typeof c.issuedTag === "string" ? c.issuedTag : null,
        lastTag: typeof c.lastTag === "string" ? c.lastTag : null,
        composerEmpty: typeof c.composerEmpty === "boolean" ? c.composerEmpty : null,
        approveKind: typeof c.approveKind === "string" ? c.approveKind : null,
        approveExp: Number.isInteger(c.approveExp) ? c.approveExp : null,
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
      chrome.tabs.sendMessage(tab.id, { type: "link-hosts", hosts: linkHosts, approveHosts: approvals.hosts }).catch(() => {});
    }
  } catch (e) {
    quiet(e);
  }
}

// The panel or host has the last word on a Send: tell the tab its link is in.
const sendingTabs = new Map();   // run tag -> tabId
function onDelivery(frame) {
  try {
    const out = deliveryMessage(frame);
    const tabId = out && sendingTabs.get(out.tag);
    if (!Number.isInteger(tabId)) return;
    sendingTabs.delete(out.tag);
    chrome.tabs.sendMessage(tabId, out).catch(() => {});
  } catch (e) {
    quiet(e);
  }
}

// A watcher caught a Send link click: check again and hand the prompt to the host.
function onSendPrompt(msg, sender) {
  try {
    if (sender?.id !== chrome.runtime.id || !String(sender?.url ?? "").startsWith("https://claude.ai/")) return;
    if (typeof msg.tag !== "string") return;
    if (Number.isInteger(sender.tab?.id)) sendingTabs.set(msg.tag, sender.tab.id);
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

// The approval flow needs no host to work, so its state outlives the port, the worker and an
// extension reload: hosts as last sent, clicked tabs by a hash of the token, waiting runs, runs seen.
const APPROVALS_KEY = "switchboardApprovals";
let approvals = pruneApprovals();
const approvalsReady = (async () => {
  try {
    approvals = pruneApprovals((await chrome.storage.local.get(APPROVALS_KEY))[APPROVALS_KEY]);
  } catch (e) {
    quiet(e);
  }
})();
const saveApprovals = () => {
  approvals = pruneApprovals(approvals);
  if (port) scheduleTabs();
  return chrome.storage.local.set({ [APPROVALS_KEY]: approvals }).catch(quiet);
};

async function tokenKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Reading an approval page needs its host allowed at run time, from a click (spec §2, rule 8).
// The click is the "Allow Alfred's sites" item service-worker.js puts on the toolbar icon.
const allowed = (host) => chrome.permissions.contains({ origins: hostOrigins([host]) });

async function showGrant() {
  try {
    await approvalsReady;
    const missing = [];
    for (const h of approvals.hosts) if (!(await allowed(h))) missing.push(h);
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
  if (!approvals.hosts.length) return grantSay("no site list from the panel yet, so nothing to allow. Is the Switchboard panel installed?");
  chrome.permissions.request({ origins: hostOrigins(approvals.hosts) }).then(
    (granted) => { if (!granted) grantSay("the sites were not allowed."); showGrant(); },
    (e) => grantSay(`Chrome refused to ask: ${e?.message ?? e}`),
  );
}

// The approval result (spec 8.1): an approval page on a listed host reports its run id,
// and "sql <run id>", or its cancelled form, goes to the tab its link was clicked in, once that chat is idle.
let posting = false;

// A watcher saw an approval link clicked. The link opens as usual.
async function onApproveClick(msg, sender) {
  try {
    await approvalsReady;
    const tabId = sender?.tab?.id;
    const url = normaliseUrl(sender?.tab?.url);
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(tabId) || !url.startsWith("https://claude.ai/")) return;
    const token = approveTokenOf(msg.href, approvals.hosts);
    if (!token) return;
    const key = await tokenKey(token);
    approvals.clicks[key] = { tabId, url, at: Date.now(), ...approveLinkInfo(msg.href) };
    await saveApprovals();
  } catch (e) {
    quiet(e);
  }
}

// The page has opened: the clicked link in the chat says Sent.
async function noteApproveOpened(tabId, url) {
  const token = approveTokenOf(url, approvals.hosts);
  const click = approvals.clicks[await tokenKey(token)];
  if (!click) return;
  click.approveTabId = tabId;
  await saveApprovals();
  chrome.tabs.sendMessage(click.tabId, { type: "approve-link-opened", token }).catch(() => {});
}

// The approval page says whether a run is under way. Closing the tab ends it too.
async function onApproveRunning(msg, sender) {
  try {
    await approvalsReady;
    const token = sender?.id === chrome.runtime.id ? approveTokenOf(sender?.url, approvals.hosts) : null;
    const click = token && approvals.clicks[await tokenKey(token)];
    if (!click) return;
    click.runningAt = msg.running ? Date.now() : null;
    await saveApprovals();
  } catch (e) {
    quiet(e);
  }
}

async function onApproveTabGone(tabId) {
  try {
    await approvalsReady;
    const click = Object.values(approvals.clicks).find((c) => c.approveTabId === tabId && c.runningAt);
    if (!click) return;
    click.runningAt = null;
    await saveApprovals();
  } catch (e) {
    quiet(e);
  }
}

async function watchApprovePage(tabId, url) {
  try {
    await approvalsReady;
    if (!isApprovePage(url, approvals.hosts)) return;
    await noteApproveOpened(tabId, url);
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

async function onApproveRun(msg, sender) {
  try {
    await approvalsReady;
    const token = sender?.id === chrome.runtime.id ? approveTokenOf(sender?.url, approvals.hosts) : null;
    if (!token) return;
    const run = cleanRun(msg);
    if (!run || approvals.seen[run.runId]) return;
    const key = await tokenKey(token);
    approvals.seen[run.runId] = Date.now();
    approvals.runs.push({ ...run, from: approvals.clicks[key], approveTabId: sender.tab?.id, at: Date.now() });
    // Its run has finished, so this link never counts as live again, whatever the post does.
    if (approvals.clicks[key]) approvals.spent[key] = { ...approvals.clicks[key], at: Date.now() };
    delete approvals.clicks[key];
    await saveApprovals();
    postRuns();
  } catch (e) {
    quiet(e);
  }
}

// Open approval pages lose their watcher when the extension reloads, and get no new "complete" event.
async function watchOpenApprovePages() {
  try {
    await approvalsReady;
    for (const tab of await chrome.tabs.query({})) watchApprovePage(tab.id, tab.url);
  } catch (e) {
    quiet(e);
  }
}

// Says why on the approval page, which is still open whenever this matters; else on the toolbar icon.
const POST_BADGE = "POST";
async function sayAboutRun(run, text) {
  if (run.note === text) return;
  run.note = text;
  await saveApprovals();
  console.info("[Alfred bridge]", run.runId, text);
  const page = Number.isInteger(run.approveTabId) ? await chrome.tabs.get(run.approveTabId).catch(() => null) : null;
  const shown = isApprovePage(page?.url, approvals.hosts) &&
    await chrome.scripting.executeScript({ target: { tabId: page.id }, func: approveStatus, args: [text, run.runId] }).then((r) => r?.[0]?.result === true, () => false);
  if (shown) return;
  await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
  await chrome.action.setBadgeText({ text: POST_BADGE });
  await chrome.action.setTitle({ title: `Alfred's Clipboard: ${text}` });
}

async function clearPostBadge() {
  if (await chrome.action.getBadgeText({}) !== POST_BADGE) return;
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: chrome.runtime.getManifest().action.default_title });
}

const dropRun = (run) => { approvals.runs = approvals.runs.filter((r) => r !== run); return saveApprovals(); };

// The watcher's answer on the live page. A tab with no watcher, after a reload, gets one first.
async function askChat(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: "post-check" }).then((a) => a?.did, () => null);
  const did = await ask();
  if (did) return did;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["claude-watch.js"] }).catch(quiet);
  return ask();
}

// Try again on the approval page: the same guards, once more.
async function onApproveRetry(msg, sender) {
  try {
    await approvalsReady;
    if (sender?.id !== chrome.runtime.id || !isApprovePage(sender?.url, approvals.hosts)) return;
    const run = approvals.runs.find((r) => r.runId === msg.runId);
    if (!run) return;
    run.stopped = false;
    run.note = null;
    await saveApprovals();
    postRuns();
  } catch (e) {
    quiet(e);
  }
}

async function postRuns() {
  if (posting) return;
  posting = true;
  try {
    await approvalsReady;
    // One try each. A run that couldn't go waits for Try again: posting by itself later could land
    // while Alex is mid-message, or after he has pasted the line himself.
    const runs = approvals.runs.filter((r) => !r.stopped);
    if (!runs.length) return;
    const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
    const { chats } = buildChatsMessage(tabs, windows, reports, viewedAt);
    for (const run of runs) {
      const line = runLine(run);
      const { chat, why } = chatForRun(chats, run);
      // Asked of the live page before anything moves, so a busy chat isn't even brought forward.
      let did = chat ? await askChat(chat.tabId) : null;
      if (!postProblem(chat, why, did)) {
        // Typing into the box needs its tab showing, as Send cli does.
        await chrome.tabs.update(chat.tabId, { active: true });
        await chrome.windows.update(chat.windowId, { focused: true });
        did = (await chrome.tabs.sendMessage(chat.tabId, { type: "post-line", text: line }).catch(() => null))?.did;
      }
      if (did === "sent") {
        await dropRun(run);
        await clearPostBadge();
        // Alex may have closed it already; then there is nothing to do.
        const page = Number.isInteger(run.approveTabId) ? await chrome.tabs.get(run.approveTabId).catch(() => null) : null;
        if (closesApproveTab(did, page?.url, approvals.hosts)) await chrome.tabs.remove(run.approveTabId).catch(quiet);
      } else {
        run.stopped = true;
        await sayAboutRun(run, notPostedText(did, postProblem(chat, why, did) ?? "the post wasn't confirmed"));
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
        approvalsReady.then(async () => {
          approvals.hosts = linkHosts;
          await saveApprovals();
          sendTabs();
          injectWatchers();
          broadcastHosts();
          showGrant();
          watchOpenApprovePages();
        });
      }
      if (msg?.type === "command" && typeof msg.id === "string") onCommand(msg);
      if (msg?.type === "delivery") onDelivery(msg);
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
  chrome.tabs.onRemoved?.addListener((tabId) => { reports.delete(tabId); viewedAt.delete(tabId); onApproveTabGone(tabId); });
  // An in-place move from /new to /chat/<id>: nudge the watcher to report at once.
  chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
    if (port && change.url?.startsWith("https://claude.ai/")) {
      chrome.tabs.sendMessage(tabId, { type: "watch-recheck" }).catch(() => {});
    }
    if (port && change.url) onSendTab(tab, change.url);
    if (change.status === "complete") watchApprovePage(tabId, tab.url);
  });
  chrome.tabs.onCreated?.addListener((tab) => { if (port) onSendTab(tab, tab.pendingUrl ?? tab.url); });
  // Returns false: any reply is sent at once, so Chrome holds no channel open (as service-worker.js does).
  // The one exception waits for the stored hosts, which a worker just woken hasn't read yet.
  chrome.runtime.onMessage?.addListener((msg, sender, reply) => {
    if (msg?.type === "chat-state") onWatchReport(msg, sender);
    if (msg?.type === "send-prompt") onSendPrompt(msg, sender);
    if (msg?.type === "approve-click") onApproveClick(msg, sender);
    if (msg?.type === "approve-running") onApproveRunning(msg, sender);
    if (msg?.type === "approve-run") onApproveRun(msg, sender);
    if (msg?.type === "approve-retry") onApproveRetry(msg, sender);
    if (msg?.type === "link-hosts?") {
      approvalsReady.then(() => reply({ hosts: linkHosts, approveHosts: approvals.hosts }));
      return true;
    }
    return false;
  });
  chrome.contextMenus?.onClicked.addListener((info) => { if (info.menuItemId === "allow-alfred-sites") grantHosts(); });
  chrome.permissions?.onRemoved.addListener(showGrant);
  // An open native port keeps the worker alive, so this keeps running while connected.
  setInterval(() => { postRuns(); if (port) sendTabs(), showGrant(); }, HEARTBEAT_MS);
  connect();
  // After a reload or a restart: pick up open approval pages and any run still waiting.
  watchOpenApprovePages();
  postRuns();
} catch (e) {
  quiet(e);
}
