// The popup exists for one reason: a toolbar badge can hold one character, and a
// failure needs a sentence. It shows the last result and nothing else.
//
// ⚠️ IT SWITCHES ITSELF OFF AS IT OPENS. The manifest declares no popup, so
// clicking the icon clips; a failure turns the popup on for one click so this
// page can be read. Clearing it here means the NEXT click goes back to clipping
// rather than reopening a stale error. Done first, before any rendering, so an
// exception below cannot leave the icon stuck on "show the popup".
chrome.action.setPopup({ popup: "" });

const bodyEl = document.getElementById("body");

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  return d.toLocaleString();
}

function rows(pairs) {
  const shown = pairs.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!shown.length) return "";
  return `<dl>${shown.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

(async function render() {
  const { lastResult, busyNotice } = await chrome.storage.local.get(["lastResult", "busyNotice"]);

  // A capture in flight is the most useful thing to say, so it goes first and
  // pushes the previous result down. Cleared by the service worker when the next
  // clip starts, so it cannot linger and mislead.
  if (busyNotice && Date.now() - new Date(busyNotice.at).getTime() < 5 * 60 * 1000) {
    bodyEl.innerHTML =
      `<div class="verdict" style="color:#d97706">Already clipping</div>` +
      `<p class="msg">${esc(busyNotice.message)}</p>`;
    return;
  }

  if (!lastResult) {
    bodyEl.innerHTML =
      `<p class="msg">Nothing clipped yet on this machine. Open a web page and press ` +
      `“Clip this page”, or use Ctrl+Shift+Y.</p>`;
    return;
  }

  if (lastResult.ok) {
    bodyEl.innerHTML =
      `<div class="verdict ok">Saved${lastResult.screenshotError ? " (text only)" : ""}</div>` +
      (lastResult.screenshotError
        ? `<p class="msg">The text and links saved, but the screenshot failed:\n\n${esc(lastResult.screenshotError)}</p>`
        : "") +
      (lastResult.screenshotNote
        ? `<p class="msg">${esc(lastResult.screenshotNote)}</p>`
        : "") +
      rows([
        ["Page", lastResult.title],
        ["Address", lastResult.url],
        ["Slices", lastResult.sliceCount],
        ["Text", lastResult.textChars ? `${lastResult.textChars.toLocaleString()} characters` : ""],
        ["Links", lastResult.linkCount],
        ["Page size", lastResult.pageSize ? `${lastResult.pageSize.width} x ${lastResult.pageSize.height} px` : ""],
        ["Text cut at 1 MB", lastResult.textTruncated ? "yes" : ""],
        ["Screenshot complete", lastResult.screenshotTruncated ? "no" : "yes"],
        // The overlap measurements, so an odd screenshot can be diagnosed from
        // here rather than by pulling slices out of storage.
        ["Slice joins", Array.isArray(lastResult.overlapDiffs) && lastResult.overlapDiffs.length
          ? lastResult.overlapDiffs.join(", ")
          : ""],
        ["Clip id", lastResult.clipId],
      ]) +
      `<div class="when">${esc(when(lastResult.at))}</div>`;
    return;
  }

  bodyEl.innerHTML =
    `<div class="verdict bad">Failed</div>` +
    `<p class="msg">${esc(lastResult.error || "No error was recorded.")}</p>` +
    rows([
      ["Page", lastResult.title],
      ["Address", lastResult.url],
      ["Stage", lastResult.stage],
    ]) +
    `<div class="when">${esc(when(lastResult.at))}</div>`;
})();

document.getElementById("retry").addEventListener("click", () => {
  // The service worker owns clipping; asking it keeps one code path rather than a
  // second, subtly different one living in the popup. The popup closes straight
  // away because clipping outlives it.
  chrome.runtime.sendMessage({ type: "clip-now" });
  window.close();
});

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
