import { groupLink, overwatchCopyText, recordLink } from "./overwatchCopy";

test("record and group links", () => {
  expect(recordLink("abc123def456ghi7")).toBe("https://alfredv5vibe.vercel.app/abc123def456ghi7");
  expect(groupLink("mvnv8pa2v6zip3xnpm")).toBe("https://alfredv5vibe.vercel.app/groups/detail/mvnv8pa2v6zip3xnpm");
});

test("prefix, facts, ids, link and question, in that order", () => {
  const text = overwatchCopyText({
    what: "project",
    name: "overwatch-q4n Overwatch",
    facts: ["Where now: Phase 6", null, "Steps: 30 of 47 (original 40)"],
    ids: { group_id: "g1", project_code: "overwatch-q4n", empty: "" },
    link: "https://alfredv5vibe.vercel.app/groups/detail/g1",
    question: "What should I do about this?",
  });
  expect(text).toBe([
    "Overwatch: project — overwatch-q4n Overwatch",
    "Where now: Phase 6",
    "Steps: 30 of 47 (original 40)",
    "group_id: g1, project_code: overwatch-q4n",
    "https://alfredv5vibe.vercel.app/groups/detail/g1",
    "",
    "What should I do about this?",
  ].join("\n"));
});

test("only what is given", () => {
  expect(overwatchCopyText({ what: "note" })).toBe("Overwatch: note");
});
