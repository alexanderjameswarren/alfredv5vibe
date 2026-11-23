// sb3_pages-h6v A3: the desktop check (spec part 6). The page asks the Alfred extension once (at page open, on
// "Check again", and at the Approve click) and waits one 2-second deadline for one reply. Nothing repeats by itself:
// no polling, no interval, no retry. The messages are a proposal to plumbing: see docs/technical-spec-sb3_pages-h6v.md,
// part 2 "Owned elsewhere" (the messages) and part 6 (the check and the "Desktop not ready" section).

export const CHECK_MESSAGE = 'switchboard-desktop-check';
export const STATE_MESSAGE = 'switchboard-desktop-state';
/** Proposed: the extension sets this on <html> when it has injected into the page. */
export const EXTENSION_MARK = 'data-switchboard-extension';
export const ANSWER_WAIT_MS = 2000;

/** Four page states in six answers: running; not running in three forms (panel, helper or both); no extension; no answer. */
export const ANSWERS = ['running', 'panel_down', 'helper_down', 'not_running', 'no_extension', 'no_answer'];

/** The extension's reply (or none) as one answer. `markPresent`: the extension's page mark was there. */
export function classify(reply, markPresent) {
  if (!reply) return { answer: markPresent ? 'no_answer' : 'no_extension', panel: false, helper: false };
  const panel = reply.panel === true;
  const helper = reply.helper === true;
  const answer = panel && helper ? 'running' : panel ? 'helper_down' : helper ? 'panel_down' : 'not_running';
  return { answer, panel, helper, extension_version: typeof reply.extension_version === 'string' ? reply.extension_version : null };
}

/** The made-up answer a simulation gives, in the same shape as a classified reply. */
export function simulatedState(answer) {
  return { answer, panel: answer === 'running' || answer === 'helper_down', helper: answer === 'running' || answer === 'panel_down' };
}

const newId = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `dc-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Ask once. Unused until B4, whose real source's checkDesktop is this. Posts {type: CHECK_MESSAGE, id} to this window and resolves with the first reply carrying the same id
 * from this window, or, after one 2-second deadline, with no reply. Either way the listener and deadline are gone.
 */
export function askDesktop({ win = window, doc = document, waitMs = ANSWER_WAIT_MS, id = newId() } = {}) {
  return new Promise((resolve) => {
    let deadline = null;
    const finish = (reply) => {
      win.removeEventListener('message', onMessage);
      clearTimeout(deadline);
      resolve(classify(reply, doc.documentElement.hasAttribute(EXTENSION_MARK)));
    };
    function onMessage(e) {
      if (e.source !== win || e.origin !== win.location.origin || e.data?.type !== STATE_MESSAGE || e.data.id !== id) return;
      finish(e.data);
    }
    win.addEventListener('message', onMessage);
    deadline = setTimeout(() => finish(null), waitMs);
    win.postMessage({ type: CHECK_MESSAGE, id }, win.location.origin);
  });
}

const when = (rechecked) => (rechecked ? '(checked just now)' : '(checked when this page opened)');

/** The desktop line for one answer. */
// `fix: false` drops the fix sentence, for when nothing can be approved anyway (expired, sent or not run).
export function desktopLine(d, rechecked, { fix = true } = {}) {
  if (!d) return 'Checking the desktop…';
  const withFix = (fact, fixText) => (fix ? `${fact} ${fixText} ${when(rechecked)}` : `${fact} ${when(rechecked)}`);
  switch (d.answer) {
    case 'running': return `Desktop ready: Switchboard panel and helper running ${when(rechecked)}`;
    // Not ready: the required sentences whole, then when it was checked.
    case 'no_extension': return withFix('No Alfred extension in this browser.', 'Approve from Chrome on your desktop.');
    case 'no_answer': return withFix("The Alfred extension didn't answer.", 'Reload it, then Check again.');
    default: {
      const down = [d.panel ? null : 'the Switchboard panel', d.helper ? null : 'the helper'].filter(Boolean);
      const verb = down.length === 1 ? "isn't" : "aren't";
      return withFix(`Desktop not ready: ${(down.length ? down : ['Switchboard']).join(' and ')} ${verb} running.`, 'Start Switchboard on your desktop.');
    }
  }
}

/** The reason sentence under the "Desktop not ready" heading: the line without its prefix, starting with a capital. */
export function notReadyReason(d, rechecked) {
  const s = desktopLine(d, rechecked).replace(/^Desktop not ready: /, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
