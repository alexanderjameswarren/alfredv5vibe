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

- A grey `...` appears while it works. A few seconds is normal; a long page takes
  longer.
- Chrome will flash a bar saying **“Alfred's Clipboard is debugging this
  browser”**. That is expected and it goes away on its own. It is the only way
  Chrome lets anything photograph a whole page rather than just the visible part.
- A green **✓** means it saved.
- A red **!** means it failed. **Click the icon** to read what went wrong.

---

## Using it

| | |
|---|---|
| **Click the toolbar icon** | Clip this page |
| **Ctrl+Shift+Y** (Mac: ⌘+Shift+Y) | Clip this page |
| **Click the icon after a red !** | Read the error |

To change the shortcut: `chrome://extensions/shortcuts`.

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
- **A screenshot of the whole page**, scaled to 1280 pixels wide and cut into
  slices at most 900 pixels tall, overlapping slightly so no line of text is
  sliced in half. At most 24 slices — a page taller than that is saved down to
  slice 24 and marked as cut short.

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
| A page that is still loading | May fail. Let it finish and clip again. |
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
- **Geometry is unit-tested.** `lib/plan.js` is pure arithmetic — no Chrome APIs,
  no canvas — so the slice maths can be checked without a browser:

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
| `lib/page.js` | what can be clipped; reading text and links; the CDP screenshot |
| `lib/slice.js` | cutting the screenshot into JPEGs |
| `lib/api.js` | `/start`, the uploads, `/finish` |
| `lib/config.js` | the two settings, and where they live |
| `options.html` / `options.js` | the settings page |
| `popup.html` / `popup.js` | the last result, and why a failure failed |
