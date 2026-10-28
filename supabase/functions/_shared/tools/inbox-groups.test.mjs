// Tests for inbox-groups.ts.
// Run: node --experimental-strip-types --test supabase/functions/_shared/tools/inbox-groups.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSuggestedGroupId, suggestedGroupError, withSuggestedGroups } from "./inbox-groups.ts";

function fakeDb(tables) {
  const calls = [];
  return {
    calls,
    from: (table) => {
      const q = {
        select: () => q,
        in: (col, ids) => { calls.push([table, col, ids]); return Promise.resolve({ data: (tables[table] ?? []).filter((r) => ids.includes(r.id)), error: null }); },
      };
      return q;
    },
  };
}

test("checkSuggestedGroupId: not given, an id, null only where it clears", () => {
  assert.equal(checkSuggestedGroupId("t", undefined), undefined);
  assert.equal(checkSuggestedGroupId("t", " g1 "), "g1");
  assert.equal(checkSuggestedGroupId("t", null, { allowNull: true }), null);
  assert.throws(() => checkSuggestedGroupId("t", null), /leave it out/);
  assert.throws(() => checkSuggestedGroupId("t", ""), /group id from get_groups/);
  assert.throws(() => checkSuggestedGroupId("t", 5), /group id from get_groups/);
});

test("suggestedGroupError: the guard's refusal in plain words, anything else as it was", () => {
  const guard = "inbox refused: suggested group g9 is not one of your open groups (not closed, not archived).";
  assert.match(suggestedGroupError("update_inbox_item", guard, "g9"),
    /^update_inbox_item: suggested group g9 was refused: it is not one of your open groups \(it is closed, archived, someone else's, or does not exist\)\. Pick an open group with get_groups/);
  assert.equal(suggestedGroupError("create_inbox_item", "boom", null), "create_inbox_item: boom");
});

test("withSuggestedGroups: name and type label beside the id; none, gone and unnamed", async () => {
  const db = fakeDb({
    item_groups: [{ id: "g1", name: "Overwatch", group_type_id: "tp" }, { id: "g2", name: null, group_type_id: "tm" }],
    group_types: [{ id: "tp", label_singular: "Project" }, { id: "tm", label_singular: "Menu" }],
  });
  const rows = await withSuggestedGroups(db, [
    { id: "a", suggested_group_id: "g1" }, { id: "b", suggested_group_id: "g2" },
    { id: "c", suggested_group_id: null }, { id: "d", suggested_group_id: "gone" }, { id: "e" },
  ]);
  assert.deepEqual(rows.map((r) => r.suggested_group), [
    { id: "g1", name: "Overwatch", type_label: "Project" },
    { id: "g2", name: "(unnamed group)", type_label: "Menu" },
    null, null, undefined,
  ]);
  assert.deepEqual(db.calls[0], ["item_groups", "id", ["g1", "g2", "gone"]]);
});

test("withSuggestedGroups: no suggestion reads nothing", async () => {
  const db = fakeDb({});
  const rows = await withSuggestedGroups(db, [{ id: "a", suggested_group_id: null }]);
  assert.equal(rows[0].suggested_group, null);
  assert.equal(db.calls.length, 0);
});
