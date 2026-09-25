import fs from "fs";
import path from "path";
import {
  archivedAt,
  archiveOutcome,
  olderArchivedCount,
  RECENT_ARCHIVE_DAYS,
  recentlyArchived,
  undoNeedsConfirming,
  undoWarning,
} from "./inboxArchive";

// A fixed "now" so the seven-day boundary is a fact rather than a race.
const NOW = new Date("2026-09-25T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const row = (over = {}) => ({
  id: "inbox-1",
  capturedText: "Retire the ai-enrich edge function",
  sourceType: "mcp",
  archived: true,
  archiveReason: "processed",
  triagedAt: daysAgo(1),
  createdAt: daysAgo(3),
  ...over,
});

describe("which rows the section shows", () => {
  it("only the archived ones", () => {
    const rows = recentlyArchived(
      [row({ id: "gone" }), row({ id: "live", archived: false, archiveReason: null, triagedAt: null })],
      { now: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(["gone"]);
  });

  it("newest departure first — the opposite of the live inbox", () => {
    // The inbox is a queue worked from the front, so it is oldest first. This is a
    // history, and the only row you are likely to want is the one you just archived.
    const rows = recentlyArchived(
      [
        row({ id: "older", triagedAt: daysAgo(5) }),
        row({ id: "newest", triagedAt: daysAgo(0.1) }),
        row({ id: "middle", triagedAt: daysAgo(2) }),
      ],
      { now: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(["newest", "middle", "older"]);
  });

  it("orders by when it LEFT, not when it was captured", () => {
    // A capture made in June and discarded this morning belongs at the top of a section
    // titled "recently".
    const rows = recentlyArchived(
      [
        row({ id: "old-capture-new-archive", createdAt: "2026-06-01T00:00:00.000Z", triagedAt: daysAgo(0.1) }),
        row({ id: "new-capture-old-archive", createdAt: daysAgo(6), triagedAt: daysAgo(4) }),
      ],
      { now: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(["old-capture-new-archive", "new-capture-old-archive"]);
  });

  it(`covers ${RECENT_ARCHIVE_DAYS} days and no more`, () => {
    const rows = recentlyArchived(
      [row({ id: "inside", triagedAt: daysAgo(6.9) }), row({ id: "outside", triagedAt: daysAgo(7.1) })],
      { now: NOW },
    );
    expect(rows.map((r) => r.id)).toEqual(["inside"]);
  });

  it("shows everything with showAll", () => {
    const rows = recentlyArchived(
      [row({ id: "inside", triagedAt: daysAgo(1) }), row({ id: "ancient", triagedAt: daysAgo(400) })],
      { now: NOW, showAll: true },
    );
    expect(rows.map((r) => r.id)).toEqual(["inside", "ancient"]);
  });

  it("treats an UNSTAMPED archived row as old, not new", () => {
    // Pre-migration-066 rows have no triagedAt. `"" >= cutoff` is false, so they sit
    // behind "Show all" — which is the right way round: an unstamped row is a relic, not
    // something that just happened.
    const relic = { id: "relic", archived: true, archiveReason: null };
    expect(recentlyArchived([relic], { now: NOW })).toEqual([]);
    expect(recentlyArchived([relic], { now: NOW, showAll: true })).toHaveLength(1);
  });

  it("survives a missing or non-array list", () => {
    expect(recentlyArchived(undefined, { now: NOW })).toEqual([]);
    expect(recentlyArchived(null, { now: NOW })).toEqual([]);
  });

  it("falls back to createdAt when there is no triagedAt", () => {
    expect(archivedAt({ triagedAt: "t", updatedAt: "u", createdAt: "c" })).toBe("t");
    expect(archivedAt({ updatedAt: "u", createdAt: "c" })).toBe("u");
    expect(archivedAt({ createdAt: "c" })).toBe("c");
    expect(archivedAt({})).toBe("");
  });
});

describe("how many more Show all would reveal", () => {
  it("counts only what the window hides", () => {
    const rows = [
      row({ id: "a", triagedAt: daysAgo(1) }),
      row({ id: "b", triagedAt: daysAgo(30) }),
      row({ id: "c", triagedAt: daysAgo(90) }),
      row({ id: "live", archived: false, archiveReason: null, triagedAt: null }),
    ];
    expect(olderArchivedCount(rows, { now: NOW })).toBe(2);
  });

  it("is zero when everything archived is recent, so the control can hide", () => {
    // A "Show all" that shows exactly what is already on screen is a control that does
    // nothing — the same rule that keeps a source tab off the row until it has items.
    expect(olderArchivedCount([row({ triagedAt: daysAgo(2) })], { now: NOW })).toBe(0);
    expect(olderArchivedCount([], { now: NOW })).toBe(0);
  });
});

describe("what happened to it", () => {
  const RECORDS = {
    items: [{ id: "item-1", sourceInboxId: "inbox-1" }],
    intents: [{ id: "int-1", sourceInboxId: "inbox-1" }],
    events: [{ id: "ev-1", sourceInboxId: "inbox-1" }],
  };

  it("Discarded, in red", () => {
    const { label, tone } = archiveOutcome(row({ archiveReason: "discarded" }), {});
    expect(label).toBe("Discarded");
    expect(tone).toBe("text-destructive");
  });

  it("names what a processed capture became, from source_inbox_id", () => {
    expect(archiveOutcome(row(), { items: RECORDS.items }).label).toBe("Processed into an item");
    expect(archiveOutcome(row(), { intents: RECORDS.intents }).label).toBe(
      "Processed into an intention",
    );
    expect(archiveOutcome(row(), { events: RECORDS.events }).label).toBe(
      "Processed into an event",
    );
  });

  it("joins two and three readably, in creation order", () => {
    expect(archiveOutcome(row(), { items: RECORDS.items, intents: RECORDS.intents }).label).toBe(
      "Processed into an item and an intention",
    );
    expect(archiveOutcome(row(), RECORDS).label).toBe(
      "Processed into an item, an intention and an event",
    );
  });

  it("says plain Processed rather than guessing when nothing points back", () => {
    // It happens honestly: triage can add a capture to a collection, and the FK is
    // ON DELETE SET NULL, so a deleted record takes its own link with it.
    expect(archiveOutcome(row(), {}).label).toBe("Processed");
    expect(archiveOutcome(row(), { items: [], intents: [], events: [] }).label).toBe("Processed");
  });

  it("ignores records belonging to a different capture", () => {
    const other = { items: [{ id: "item-9", sourceInboxId: "inbox-OTHER" }] };
    expect(archiveOutcome(row(), other).label).toBe("Processed");
  });

  it("counts a record that was itself archived later — this is a history", () => {
    const binned = { items: [{ id: "item-1", sourceInboxId: "inbox-1", archived: true }] };
    expect(archiveOutcome(row(), binned).label).toBe("Processed into an item");
  });

  it("says Archived, not Processed, for a row with no reason at all", () => {
    // Rows from before migration 066 gave the column a job. Calling one "Processed"
    // would be an invention.
    const { label, reason } = archiveOutcome(row({ archiveReason: null }), {});
    expect(label).toBe("Archived");
    expect(reason).toBe("unknown");
  });

  it("is muted unless it is a discard", () => {
    expect(archiveOutcome(row(), RECORDS).tone).toBe("text-muted-foreground");
    expect(archiveOutcome(row({ archiveReason: null }), {}).tone).toBe("text-muted-foreground");
  });
});

// ── The one honest problem with an Undo on a processed row ────────────────────
describe("warning before an Undo that cannot undo everything", () => {
  const RECORDS = { items: [{ id: "item-1", sourceInboxId: "inbox-1" }], intents: [], events: [] };

  it("asks first on a processed row", () => {
    // `handleInboxSave` offers no Undo of its own precisely because un-archiving cannot
    // remove what the capture became. The button exists now, so it warns instead of
    // pretending.
    expect(undoNeedsConfirming(row(), RECORDS)).toBe(true);
  });

  it("does NOT ask on a discarded row", () => {
    // A discard created nothing, so there is nothing to warn about.
    expect(undoNeedsConfirming(row({ archiveReason: "discarded" }), RECORDS)).toBe(false);
  });

  it("does not ask on a row archived with no reason", () => {
    expect(undoNeedsConfirming(row({ archiveReason: null }), RECORDS)).toBe(false);
  });

  it("names what is already out there, and the consequence", () => {
    const text = undoWarning(row(), RECORDS);
    expect(text).toContain("became an item");
    expect(text).toContain("does NOT remove what it created");
    expect(text).toContain("two copies");
  });

  it("still warns when nothing could be named", () => {
    const text = undoWarning(row(), {});
    expect(text).toContain("was filed");
    expect(text).not.toContain("became");
    expect(text).toContain("two copies");
  });
});

// ── The guard ────────────────────────────────────────────────────────────────
describe("archived rows reach state at all", () => {
  const alfred = fs.readFileSync(path.join(__dirname, "..", "Alfred.jsx"), "utf8");

  it("neither loader throws archived rows away any more", () => {
    // 🛑 This is what the whole section depends on. Both loaders used to do
    // `.filter(item => !item.archived)` before setting state, which discarded rows the
    // query had already fetched. If that line comes back, "Recently archived" silently
    // empties and nothing else fails.
    expect(alfred).not.toContain("filter(item => !item.archived)");
  });

  it("keeps ONE list and derives the live inbox from it", () => {
    // Two slices kept in step by hand across eight writers is the shape of bug the
    // pinned footer took four rounds to fix.
    expect(alfred).toContain(
      "const inboxItems = useMemo(() => allInboxItems.filter((i) => !i.archived), [allInboxItems]);",
    );
    expect(alfred).not.toContain("setInboxItems(");
  });
});
