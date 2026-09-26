/**
 * Tests for the tag-pool helpers: `tagPoolFrom` and `tagPoolForRecords`.
 *
 * A separate file from `tags.test.js` on purpose. That file is the SHARED
 * CONTRACT with the Deno twin `supabase/functions/_shared/tags.ts` — a case
 * added there is a case the twin must satisfy too. The pool functions are
 * front-end only and have no twin, so their cases do not belong in that file.
 *
 * Both functions lived unexported in src/Alfred.jsx until 2026-09-25, where
 * nothing could import them. These are their first tests.
 */

import { tagPoolFrom, tagPoolForRecords } from "./tags";

const rec = (tags, archived = false) => ({ tags, archived });

describe("tagPoolFrom", () => {
  test("orders by frequency", () => {
    const pool = tagPoolFrom([rec(["rare"]), rec(["common"]), rec(["common"])]);
    expect(pool).toEqual(["common", "rare"]);
  });

  test("equal frequency ties are alphabetical", () => {
    expect(tagPoolFrom([rec(["tjs"]), rec(["aldi"]), rec(["whole foods"])])).toEqual([
      "aldi",
      "tjs",
      "whole foods",
    ]);
  });

  test("orders by frequency, ties alphabetical", () => {
    const pool = tagPoolFrom([
      rec(["tjs"]),
      rec(["tjs"]),
      rec(["whole foods"]),
      rec(["aldi"]),
    ]);
    expect(pool).toEqual(["tjs", "aldi", "whole foods"]);
  });

  test("counts across every list passed in", () => {
    const pool = tagPoolFrom([rec(["shared"]), rec(["items"])], [rec(["shared"])]);
    expect(pool).toEqual(["shared", "items"]);
  });

  test("a tag is listed once however often it is used", () => {
    expect(tagPoolFrom([rec(["tjs"]), rec(["tjs"]), rec(["tjs"])])).toEqual(["tjs"]);
  });

  test("null and undefined lists are skipped", () => {
    expect(tagPoolFrom(null, undefined, [rec(["tjs"])])).toEqual(["tjs"]);
    expect(tagPoolFrom()).toEqual([]);
  });

  test("null records and records with no tags are skipped", () => {
    expect(tagPoolFrom([null, undefined, {}, rec(null), rec(["tjs"])])).toEqual(["tjs"]);
  });

  test("non-string and empty tags are ignored", () => {
    const pool = tagPoolFrom([rec([null, undefined, 7, "", {}, ["nested"], "tjs"])]);
    expect(pool).toEqual(["tjs"]);
  });

  test("empty in, empty out", () => {
    expect(tagPoolFrom([], [])).toEqual([]);
  });
});

describe("tagPoolForRecords", () => {
  test("a tag only on an archived row is left out", () => {
    // The §A6 bug: `overdue` lived on archived rows and the picker kept
    // offering it when no living record carried it.
    const pool = tagPoolForRecords(
      [rec(["groceries"]), rec(["overdue"], true)],
      [rec(["errands"], true)]
    );
    expect(pool).toEqual(["groceries"]);
  });

  test("a tag on both an archived and a live row survives", () => {
    expect(tagPoolForRecords([rec(["tjs"]), rec(["tjs"], true)], [])).toEqual(["tjs"]);
  });

  test("archived rows do not contribute to the count", () => {
    // `aldi` wins on live rows 2-1; five archived `tjs` must not outrank it.
    const pool = tagPoolForRecords(
      [rec(["aldi"]), rec(["aldi"]), rec(["tjs"])],
      Array.from({ length: 5 }, () => rec(["tjs"], true))
    );
    expect(pool).toEqual(["aldi", "tjs"]);
  });

  test("items and intentions share one pool", () => {
    expect(tagPoolForRecords([rec(["shared"])], [rec(["shared"]), rec(["only"])])).toEqual([
      "shared",
      "only",
    ]);
  });

  test("null and undefined lists are safe", () => {
    expect(tagPoolForRecords(null, undefined)).toEqual([]);
    expect(tagPoolForRecords(undefined, [rec(["tjs"])])).toEqual(["tjs"]);
  });

  test("non-arrays give an empty pool rather than throwing", () => {
    expect(tagPoolForRecords("items", {})).toEqual([]);
  });

  test("a missing archived field counts as live", () => {
    expect(tagPoolForRecords([{ tags: ["tjs"] }], [])).toEqual(["tjs"]);
  });
});
