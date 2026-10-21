# Inbox row cap (inbox_rowcap-x7k) — progress

Bug (2026-10-20): the inbox stopped showing new captures. Both loaders read
`inbox.select("*")` with no filter; since Step 22 kept archived rows, the table passed
PostgREST's 1000-row cap and an unordered 1000 came back. No database change.

## Step 1 — plan (2026-10-21, s1)
- [x] Read-only plan; Alfred.jsx and useAlfredData.js released by restructure_p5-h7m.

## Step 2 — build (2026-10-21, s2)
- [x] `src/alfred/inboxQueries.js`: live, recent-window, older page and count, by-id
      queries; the 1000-row warning; the refresh merge; the record-link inbox id.
- [x] `useAlfredData.js`: both loaders share `coreQueries` / `applyCoreData`; live and
      recent queries plus the older count; `loadOlderArchived` (50 a page);
      `ensureInboxRows` / `findInboxRow` / `inboxRowState`. A refresh keeps paged rows.
- [x] `inboxArchive.js`: `archiveCutoff`, `isRecentlyArchived`; the window reads
      `triagedAt` only, as the query does; `olderArchivedCount` removed.
- [x] `Alfred.jsx`: the three lookups via `findInboxRow`; the inbox route waits while
      its row is pending; Show all loads page one, Load more the rest; record links fetch
      the capture in `resolveRecordWithInbox` (passed as RecordLinkScreen's `resolve`).
- [x] `RecentlyArchived.jsx` / `InboxScreen.jsx`: Load more.
- [x] Tests: app suite 2792/2792 (173 suites), CLI 239/239. ESLint clean.

## Next
- Alex tests in Chrome against the local dev server, then pushes (no database change).
