// Alfred's Clipboard — the orchestrator.
//
// One toolbar click (or Ctrl+Shift+Y) runs the whole thing:
//
//   1. check the settings, and open the options page if they are missing
//   2. refuse pages Chrome will not let an extension read, with the reason
//   3. read the title, address, all the text and every link
//   4. screenshot the whole page through CDP, and slice it here in the browser
//   5. /start -> upload each slice -> /finish
//   6. badge: green tick, or a red "!" whose error the popup shows
//
// Spec: docs/technical-spec-clipboard.md section 4.4.
//
// ---------------------------------------------------------------------------
// NOTHING HERE DEPENDS ON THE EXTENSION'S ID
// ---------------------------------------------------------------------------
//
// This is loaded unpacked on three machines (desktop, Surface Go, Chromebook)
// and an unpacked extension gets a DIFFERENT id on each one. So no id is written
// down anywhere: not in this code, not in the manifest, and not on the server.
// The clip-capture function reflects whatever `chrome-extension://` origin the
// request arrives with rather than matching a fixed one, and authentication is
// the shared secret, which is per-machine anyway. Adding a fourth machine needs
// no change on either side.

import { getConfig, configProblem } from "./lib/config.js";
import { blockedReason, extractPage, captureWholePage } from "./lib/page.js";
import { sliceScreenshot } from "./lib/slice.js";
import { planCapture } from "./lib/plan.js";
import { startClip, finishClip, uploadSlice } from "./lib/api.js";

const LAST_RESULT_KEY = "lastResult";

/** How long a green tick stays before clearing itself. Failures do not clear. */
const SUCCESS_BADGE_MS = 8000;

// ---------------------------------------------------------------------------
// Badge and popup state
// ---------------------------------------------------------------------------
//
// ⚠️ THE POPUP IS SET AND UNSET, NOT DECLARED. Chrome gives you one or the other:
// with `default_popup` in the manifest, `action.onClicked` never fires and the
// icon could not clip at all. So the manifest declares NO popup — clicking clips
// — and a failure switches the popup on for the next click only. popup.js turns
// it back off as it opens, so the click after that clips again.

async function setWorking() {
  await chrome.action.setPopup({ popup: "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  await chrome.action.setBadgeText({ text: "..." });
  await chrome.action.setTitle({ title: "Alfred's Clipboard: clipping..." });
}

async function setSuccess(summary) {
  await chrome.action.setPopup({ popup: "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  await chrome.action.setBadgeText({ text: "✓" });
  await chrome.action.setTitle({ title: `Alfred's Clipboard: ${summary}` });
  // Cleared after a while so a tick from an hour ago is not mistaken for this
  // page's result. Best effort: an MV3 service worker can be shut down before
  // the timer fires, in which case the tick simply stays up. That is why it is a
  // setTimeout and not an alarm — a lingering tick is cosmetic, and a permanent
  // alarm for cosmetics is worse. The stored record is unaffected either way.
  setTimeout(() => {
    chrome.action.getBadgeText({}).then((t) => {
      if (t === "✓") chrome.action.setBadgeText({ text: "" });
    });
  }, SUCCESS_BADGE_MS);
}

async function setFailure(message) {
  // The next click opens the popup instead of clipping, which is the only way to
  // show a message this long from a toolbar button.
  await chrome.action.setPopup({ popup: "popup.html" });
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setTitle({ title: "Alfred's Clipboard: failed — click for details" });
  console.error("[Alfred Clipboard]", message);
}

/** The popup reads this; it is the only record of what happened. */
async function record(result) {
  await chrome.storage.local.set({
    [LAST_RESULT_KEY]: { ...result, at: new Date().toISOString() },
  });
}

// ---------------------------------------------------------------------------
// The clip
// ---------------------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab to clip.");
  return tab;
}

async function clipActiveTab() {
  await setWorking();

  const cfg = await getConfig();
  const problem = configProblem(cfg);
  if (problem) {
    // Opening the options page IS the useful response here: a first run has
    // nothing saved, and a badge saying so would leave the user hunting for
    // where to fix it.
    await chrome.runtime.openOptionsPage();
    const message = `${problem} The options page is open — paste the function address and the secret, save, then clip again.`;
    await record({ ok: false, error: message, stage: "settings" });
    await setFailure(message);
    return;
  }

  const tab = await activeTab();

  const blocked = blockedReason(tab.url);
  if (blocked) {
    await record({ ok: false, error: blocked, stage: "page", url: tab.url, title: tab.title });
    await setFailure(blocked);
    return;
  }

  const capturedAt = new Date().toISOString();

  try {
    // --- text and links. A failure here IS fatal: a clip with no text is not
    // worth a row, whereas a clip with no screenshot still is (below).
    const page = await extractPage(tab.id);

    // --- screenshot, best effort. Spec 4.4: "If the screenshot fails but the
    // text succeeds, save a text-only clip and say so."
    let slices = [];
    let shotPlan = null;
    let contentSize = null;
    let screenshotError = null;
    try {
      const shot = await captureWholePage(tab.id, planCapture);
      shotPlan = shot.plan;
      contentSize = shot.contentSize;
      const sliced = await sliceScreenshot(shot.base64);
      slices = sliced.slices;
    } catch (e) {
      screenshotError = e.message;
      console.warn("[Alfred Clipboard] screenshot failed, saving text only:", e.message);
    }

    // --- /start. Called even with zero slices, because a clipboard clip needs a
    // server-minted clip_id and /start is where ids come from. It writes nothing.
    const started = await startClip(cfg.baseUrl, cfg.secret, slices.length);
    const clipId = started.clip_id;
    const uploads = started.uploads ?? [];
    if (uploads.length !== slices.length) {
      throw new Error(
        `Asked for ${slices.length} upload links and got ${uploads.length}. Nothing was saved.`,
      );
    }

    // --- uploads, in order. Sequential rather than parallel on purpose: 24
    // simultaneous multi-hundred-kilobyte PUTs from a service worker is a good
    // way to have some of them fail, and /finish would then refuse the lot.
    for (let i = 0; i < slices.length; i++) {
      await uploadSlice(uploads[i].signed_url, slices[i].blob);
    }

    // --- /finish. Verifies every path is really in storage, then writes the
    // clip row, the inbox row, and the link between them.
    const finished = await finishClip(cfg.baseUrl, cfg.secret, {
      clip_id: clipId,
      source: "clipboard",
      url: page.url || tab.url,
      title: page.title || tab.title || "",
      page_text: page.text,
      links: page.links,
      slice_paths: uploads.map((u) => u.path),
      page_width: contentSize?.width ?? null,
      page_height: contentSize?.height ?? null,
      screenshot_truncated: shotPlan?.truncated === true,
      captured_at: capturedAt,
    });

    const bits = [`${finished.slice_count} slice${finished.slice_count === 1 ? "" : "s"}`];
    if (finished.text_truncated) bits.push("text cut at 1 MB");
    if (finished.screenshot_truncated) bits.push("page too tall, bottom not captured");
    if (screenshotError) bits.push("TEXT ONLY, screenshot failed");
    const summary = bits.join(", ");

    await record({
      ok: true,
      summary,
      clipId: finished.clip_id,
      inboxId: finished.inbox_id,
      title: page.title || tab.title || "",
      url: page.url || tab.url,
      sliceCount: finished.slice_count,
      textChars: page.text.length,
      linkCount: finished.links_stored,
      textTruncated: finished.text_truncated === true,
      screenshotTruncated: finished.screenshot_truncated === true,
      screenshotError,
      pageSize: contentSize,
    });

    // A text-only clip saved successfully, but calling it a clean success would
    // hide that the screenshot is missing. Red, so it gets looked at.
    if (screenshotError) {
      await setFailure(
        `Saved as TEXT ONLY — the screenshot failed: ${screenshotError}\n\n` +
          `The clip itself is in Alfred with its text and links.`,
      );
    } else {
      await setSuccess(summary);
    }
  } catch (e) {
    const message = e?.message || String(e);
    await record({ ok: false, error: message, stage: "clip", url: tab.url, title: tab.title });
    await setFailure(message);
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
//
// A guard rather than a queue: clipping twice at once would attach the debugger
// to the same tab twice and the second attach would fail with a message about
// DevTools that has nothing to do with what happened.
let clipping = false;

async function clipOnce() {
  if (clipping) {
    console.warn("[Alfred Clipboard] already clipping; ignoring.");
    return;
  }
  clipping = true;
  try {
    await clipActiveTab();
  } finally {
    clipping = false;
  }
}

chrome.action.onClicked.addListener(() => { clipOnce(); });

chrome.commands.onCommand.addListener((command) => {
  // Its own command rather than `_execute_action`, so the keyboard shortcut
  // always clips even when a previous failure has left the popup switched on.
  if (command === "clip-page") clipOnce();
});

// The popup's "Clip this page" button.
//
// Deliberately no reply: the popup closes the moment it sends this, so calling
// sendResponse would land on a closed port and log an unchecked
// runtime.lastError. Fire and forget, and `return false` so Chrome does not hold
// the channel open waiting for an answer that is never coming.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "clip-now") clipOnce();
  return false;
});
