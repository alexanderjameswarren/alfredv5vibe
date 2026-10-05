import fs from "fs";
import path from "path";

// Guard tests read Alfred's screens as TEXT. Alfred.jsx is being split into feature
// folders (docs/technical-spec-alfred_split.md); reading through here keeps every
// guard's count the same whichever file the code has moved to.

const SRC = path.join(__dirname, "..");

// Folders that hold Alfred screens. sam/, timer/ and games/ are separate surfaces.
export const ALFRED_FOLDERS = [
  "shared",
  "contexts",
  "schedule",
  "intentions",
  "items",
  "executions",
  "inbox",
  "collections",
  "reminders",
  "recycle",
  "alfred",
];

// Files that existed outside Alfred.jsx before the split and move into the folders
// above. The guards never counted them as Alfred.jsx; alfredSource() still does not.
const NOT_FROM_ALFRED = new Set([
  "AppLink.jsx",
  "PinnedFooter.jsx",
  "EditCard.jsx",
  "InsertRowButton.jsx",
  "ItemPicker.jsx",
  "TagPicker.jsx",
  "TagFilter.jsx",
  "ListToolbar.jsx",
  "SearchInput.jsx",
  "SortControl.jsx",
  "UnderlineTabs.jsx",
  "UndoMessage.jsx",
  "RemovalMeta.jsx",
  "RepeatBlockDialog.jsx",
  "InboxDetailView.jsx",
  "InboxListCard.jsx",
  "RecentlyArchived.jsx",
  "OriginalCapture.jsx",
  "ClipboardCapture.jsx",
  "CaptureMeta.jsx",
  "PendingReminder.jsx",
  "NotificationChainInline.jsx",
  "NotificationSettings.jsx",
  "NotificationDiagnostics.jsx",
  "useExecutionRoute.js",
]);

const isTest = (f) => /\.test\.jsx?$/.test(f);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// Source files under src/<dir>, recursively, as paths relative to src/, sorted.
function walk(dir, pattern) {
  const abs = path.join(SRC, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, pattern));
    else if (pattern.test(entry.name) && !isTest(entry.name)) out.push(rel);
  }
  return out.sort();
}

const folderFiles = (pattern) => ALFRED_FOLDERS.flatMap((d) => walk(d, pattern));

/** Alfred.jsx plus every file carved out of it, joined: what "Alfred.jsx" meant before the split. */
export function alfredSource() {
  const carved = folderFiles(/\.jsx?$/).filter((f) => !NOT_FROM_ALFRED.has(path.basename(f)));
  return ["Alfred.jsx", ...carved].map(read).join("\n");
}

/** One file by name, wherever it now lives: src/ top level or a feature folder. */
export function sourceOf(name) {
  const hits = [
    ...fs.readdirSync(SRC).filter((f) => f === name),
    ...folderFiles(/\.jsx?$/).filter((f) => path.basename(f) === name),
  ];
  if (hits.length !== 1) throw new Error(`${name}: expected one file, found ${hits.length}`);
  return read(hits[0]);
}

/** [path, text] for every non-test .jsx screen file: src/ top level and the feature folders. */
export function screenFiles() {
  const top = fs.readdirSync(SRC).filter((f) => /\.jsx$/.test(f) && !isTest(f));
  return [...top, ...folderFiles(/\.jsx$/)].map((f) => [f, read(f)]);
}
