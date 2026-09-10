import { matchesQuery } from "./search";

describe("matchesQuery", () => {
  test("empty or whitespace-only query matches everything", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("   ", "anything")).toBe(true);
    expect(matchesQuery("", null)).toBe(true);
    expect(matchesQuery("")).toBe(true);
  });

  test("non-string query is treated as empty", () => {
    expect(matchesQuery(null, "x")).toBe(true);
    expect(matchesQuery(undefined, "x")).toBe(true);
  });

  test("case-insensitive substring match, query trimmed", () => {
    expect(matchesQuery("salt", "Kosher Salt")).toBe(true);
    expect(matchesQuery("  SALT  ", "kosher salt")).toBe(true);
    expect(matchesQuery("pepper", "Kosher Salt")).toBe(false);
  });

  test("inner whitespace in the query is kept", () => {
    expect(matchesQuery("kosher salt", "Kosher Salt")).toBe(true);
    expect(matchesQuery("kosher  salt", "Kosher Salt")).toBe(false);
  });

  test("matches if any field matches", () => {
    expect(matchesQuery("oven", "Bread", null, "Preheat oven")).toBe(true);
    expect(matchesQuery("oven", "Bread", "Knead")).toBe(false);
  });

  test("non-string fields are skipped, not thrown on", () => {
    expect(() => matchesQuery("a", null, undefined, 42, {}, [])).not.toThrow();
    expect(matchesQuery("42", 42)).toBe(false);
    expect(matchesQuery("a", null, undefined)).toBe(false);
  });

  test("no fields with a real query matches nothing", () => {
    expect(matchesQuery("a")).toBe(false);
  });
});
