# Alfred's Clipboard — Chrome extension

One click saves the page you are looking at into Alfred: all of its text, every
link on it, and a screenshot of the whole page (not just the part you can see).
Any claude.ai conversation can then read it.

There is **no build step**. The files here are the extension.

---

## Installing it on a machine

You do this once per computer. It takes about three minutes. You have to do it on
each machine separately — desktop, Surface Go, Chromebook — because an extension
loaded this way lives only on the computer you loaded it on.

### 1. Get the folder onto the machine

The extension is the `extension` folder inside the `alfred-v5` project. If the
project is already cloned on this machine, you are done — you will point Chrome at
`…\alfred-v5\extension`.

Write down the full path, because you will need to find it in a file picker:

- Windows: `C:\Users\Alex\projects\alfred-v5\extension`
- Chromebook: wherever you cloned it, e.g. `/home/alex/projects/alfred-v5/extension`

### 2. Turn on Developer mode in Chrome

1. Open Chrome.
2. In the address bar type **`chrome://extensions`** and press Enter.
3. Top right of that page, there is a switch labelled **Developer mode**. Turn it
   **on**. Three new buttons appear along the top left.

### 3. Load the extension

1. Click **Load unpacked** (one of the buttons that just appeared).
2. A folder picker opens. Navigate to the `extension` folder from step 1 and
   select the **folder itself** — not a file inside it, and not the `alfred-v5`
   folder above it. Click **Select Folder**.
3. A card appears titled **Alfred's Clipboard**. That is it installed.

If Chrome shows a red error instead, the most likely cause is picking the wrong
folder. The one you want is the one containing `manifest.json`.

### 4. Pin it to the toolbar

Chrome hides new extensions behind a jigsaw-piece icon.

1. Click the **jigsaw piece** to the right of the address bar.
2. Find **Alfred's Clipboard** in the list.
3. Click the **pin** next to it. Its icon now sits in the toolbar permanently.

### 5. Fill in the two settings

1. On `chrome://extensions`, find the Alfred's Clipboard card and click
   **Details**.
2. Scroll down and click **Extension options**. (You can also right-click the
   toolbar icon and choose **Options**.)
3. **Function address** is already filled in. Leave it.
4. **Shared secret**: paste the value of `CLIPBOARD_SECRET` — the same string
   that was set with `supabase secrets set`. It is at least 32 characters. Use
   **Show** to check you pasted it whole, with no stray spaces.
5. Click **Save**. You should see a green confirmation.

The secret is stored only on this machine, in Chrome's local extension storage.
It is deliberately *not* in any file in the project, and it deliberately does
**not** sync to your other computers — paste it on each one.

### 6. Try it

Open a normal web page — a job posting is a good test — and click the toolbar
icon.

- A grey `...` appears while it works. A couple of seconds is normal.
- A green **✓** means it saved. **No banner appears** — the ordinary click never
  uses Chrome's debugger.
- A red **!** means it failed. **Click the icon** to read what went wrong.

Now try the other mode: **right-click the icon → Clip full page**. This time
Chrome flashes a bar saying **“Alfred's Clipboard is debugging this browser”**,
and the badge counts slices (`1/7`, `2/7`…). The bar is expected and goes away on
its own — it is the only way Chrome lets anything photograph a whole page.

---

## Using it

There are **two modes**, and the difference is whether Chrome puts a bar across
the top of your window.

| | | |
|---|---|---|
| **Click the toolbar icon** | **Ctrl+Shift+Y** | Clip the **visible screen**. Silent — no banner. This is the everyday one. |
| **Right-click the icon → Clip full page** | **Ctrl+Shift+U** | Clip the **whole page**, top to bottom. Chrome shows its debugging bar while it works. |
| **Click the icon after a red !** | | Read what went wrong |

Both modes save **all** of the page's text and **every** link. The only
difference is how much of it is photographed. Since Claude reads the text first
and the picture only when layout matters, the silent mode is right almost all of
the time — reach for **Clip full page** when you need to *see* something further
down, like a chart or a layout.

To change either shortcut: `chrome://extensions/shortcuts`.

Then, in any claude.ai conversation: *“I just clipped a job posting”*. Claude
reads the text first and only fetches the screenshot when the layout matters.

When Claude has dealt with a clip it archives the inbox item, so it stops coming
back. If you want rid of one yourself, use the trash can on its card in the
Alfred app — that archives it too, it does not destroy it.

---

## What gets saved

- **All the page's text**, exactly as it reads on screen. Nothing is summarised
  or extracted, which means a clipped job board holds *every* posting on it, not
  one. Claude is told to expect that.
- **Every link**, as text plus its full address. This is how Claude can point you
  at other listings on a page without you clipping each one.
- **A screenshot.** On an ordinary click that is **one photograph of the visible
  screen** — deliberately not the whole page, and not treated as a failure or as
  incomplete. On **Clip full page** it is the whole page at 1280 pixels wide, in
  slices at most 900 pixels tall that overlap slightly so no line of text is cut
  in half, each photographed separately (see below). At most 24 — a taller page
  is saved down to slice 24 and **marked as incomplete**.

Every clip carries a plain-English note saying which kind of screenshot it is, so
Claude can never mistake a screen for a page, or a deliberate choice for a fault.

A clip will never claim a complete screenshot it does not have. Consecutive
slices are supposed to share 50 rows, so after capturing them the extension
checks that each one really does follow on from the one before. If a join does
not match, the slices from that point are **thrown away** and the clip is marked
incomplete, with the reason in the popup. Better a short screenshot that says so
than a long one that quietly shows the wrong thing.

Caps, so nothing runs away: text is trimmed at 1 MB and links at 1,000. Both are
flagged on the saved clip when they bite.

---

## When it will not work, and why

Some of these are Chrome's rules, not choices made here.

| Page | What happens |
|---|---|
| `chrome://` pages, other extensions, `view-source:`, local files | Refused with a message. Chrome does not let extensions read its own pages. |
| Chrome Web Store | Refused. Specifically walled off by Chrome. |
| A PDF in Chrome's viewer | Refused. The text is not in the page, so a clip would save nothing. |
| **DevTools open on that tab** | Refused, with a message telling you to close it. Chrome allows only one debugger per tab and the screenshot needs it. |
| A page that is still loading | May fail, or lose its lower slices to the coherence check if it re-lays out mid-capture. Let it finish loading and clip again. |
| **You navigate away mid-capture** | Aborted. Nothing is saved, and the popup says the page changed. A clip assembled from two different pages would be a convincing lie. |
| **You close the tab mid-capture** | Aborted the same way, with its own message. |
| Content that scrolls inside its own box | **Clip full page** captures only as far as the picture keeps advancing, then stops and says so. Known limitation, not being chased — the text is complete either way. |
| Floating bars fixed to the screen | Appear partway down a full-page screenshot, where they happened to be. Cosmetic; known and accepted. |
| **Clicking twice** | The second click is ignored with an "already clipping" message, so you cannot end up with two copies of the page. |
| Screenshot fails but text works | **Saves anyway**, text-only, and shows a red `!` explaining why. The clip is in Alfred with its text and links. |

If a very large page fails part way through, clipping again is safe. Nothing is
recorded until every slice is confirmed uploaded, so a half-finished clip leaves
no row behind — only some unused upload links, which expire on their own.

---

## Notes for whoever maintains this

- **No fixed extension ID.** Loaded unpacked, the ID differs on every machine.
  Nothing depends on it: the `clip-capture` function reflects whatever
  `chrome-extension://` origin a request arrives with rather than matching a
  known one, and authentication is the shared secret. Adding a machine needs no
  server change.
- **No icons.** Chrome draws a lettered placeholder, which is enough to find on
  the toolbar. Dropping `icons/16.png`, `48.png`, `128.png` in and adding an
  `icons` block plus `action.default_icon` to `manifest.json` is all it would
  take.
- **`host_permissions` names the Supabase project explicitly.** A different
  project means editing `manifest.json` as well as the options page.
- **The popup is switched on and off, not declared.** Chrome fires
  `action.onClicked` only when there is no `default_popup`, so the manifest
  declares none and clicking clips. A failure turns the popup on for exactly one
  click; `popup.js` turns it off again as it opens.
- **The default is silent on purpose.** `chrome.tabs.captureVisibleTab` needs no
  debugger, so no banner. The full-page path needs `chrome.debugger` and there is
  no way to suppress the bar it raises — so it became an explicit, separate
  action rather than something that happens several times a day.

- **`screenshot_truncated` stays FALSE for a visible capture.** It is a fault
  flag: it drives a "⚠️ INCOMPLETE" warning and tells Claude to distrust the
  picture. A visible capture lost nothing it tried to get. What stops it being
  mistaken for a whole page is `capture_mode` plus the note, both of which travel
  with the clip and are surfaced by both tools.

- **Each slice is a separate screenshot, and that is not an accident.** The first
  version asked Chrome for the whole page in one `Page.captureScreenshot` with
  `captureBeyondViewport`. On two ordinary pages (~1905 x 10400) the bottom of the
  returned image was a repeat of the TOP of the page — the last slices showed the
  opening photo and the site header again. A ~6000-tall page had been fine. The
  slicing was provably right (tile counts and the 191px last tile matched the
  planner exactly), so the bitmap Chrome handed back was wrong inside it, which is
  what exceeding an internal surface limit looks like. `clip.scale` does not help,
  because the limit is on what Chrome composites rather than what it returns.

  Capturing one tile at a time means no single capture is ever more than ~1350 CSS
  pixels tall. It also makes the failure *detectable*: separate captures can be
  compared at their overlap, whereas two slices cut from one bitmap share the same
  corruption by construction and could never have caught it. The per-tile capture
  and `lib/verify.js` are one change, not two.

- **Geometry is unit-tested.** `lib/plan.js` is pure arithmetic — no Chrome APIs,
  no canvas — so the slice maths and the coherence decision can be checked without
  a browser:

  ```
  node extension/lib/plan.test.mjs
  ```

  `extension/package.json` exists only to tell Node these files are ES modules.
  It is not an npm package and is never installed.

### The files

| | |
|---|---|
| `manifest.json` | permissions, the shortcut, the entry points |
| `service-worker.js` | the whole clip, start to finish |
| `lib/plan.js` | scale and slice arithmetic (pure, tested) |
| `lib/page.js` | what can be clipped; reading text, links and page size; the per-tile CDP screenshot; the abort guard |
| `lib/visible.js` | the silent visible-screen capture |
| `lib/verify.js` | checking the tiles really follow on from each other |
| `lib/api.js` | `/start`, the uploads, `/finish` |
| `lib/config.js` | the two settings, and where they live |
| `options.html` / `options.js` | the settings page |
| `popup.html` / `popup.js` | the last result, and why a failure failed |
