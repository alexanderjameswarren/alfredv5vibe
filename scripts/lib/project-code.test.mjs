import test from "node:test";
import assert from "node:assert/strict";
import { classifyPrompt, projectOfTag, stripPasteWrappers, tagInPrompt } from "./project-code.mjs";

// The wrapper the VS Code Claude panel really emits: attributes on both tags.
const wrap = (body, id = "c70a") =>
  `<pasted_content id="${id}">${body}</pasted_content id="${id}">`;

const TASK = `Run tag: claims-wq7-s7f-p8wz

Some context about what happened.

# Your Task
1. Do the thing.
2. Then the other thing.`;

test("project code is everything before the step segment", () => {
  assert.equal(projectOfTag("claims-wq7-s7d-u3rb"), "claims-wq7");
  assert.equal(projectOfTag("alfred-ab1-s1-x9k2"), "alfred-ab1");
  assert.equal(projectOfTag("claims-wq7-s3fix2-aaaa"), "claims-wq7");
  assert.equal(projectOfTag("clip-7b-q4m2"), null);
});

test("wrappers come off, content untouched", () => {
  assert.equal(stripPasteWrappers(wrap("hello")), "hello");
  assert.equal(stripPasteWrappers("hello"), "hello");
  assert.equal(stripPasteWrappers(`a${wrap("b")}c${wrap("d", "e1")}f`), "abcdf");
  // A bare closing tag, and the hyphenated spelling, in case the panel changes.
  assert.equal(stripPasteWrappers("<pasted_content>x</pasted_content>"), "x");
  assert.equal(stripPasteWrappers('<pasted-content id="z">x</pasted-content id="z">'), "x");
});

test("wrapped tagged prompt: the tag is found", () => {
  const c = classifyPrompt(wrap(TASK));
  assert.ok(c.wrapped);
  assert.equal(c.tag, "claims-wq7-s7f-p8wz");
  assert.equal(projectOfTag(c.tag), "claims-wq7");
});

test("a wrapped tag is invisible without stripping — this is the bug", () => {
  assert.equal(tagInPrompt(wrap(TASK)), null);
});

test("wrapped untagged task prompt still blocks", () => {
  const c = classifyPrompt(wrap(TASK.replace(/^Run tag:.*\n/, "")));
  assert.equal(c.tag, null);
  assert.equal(c.pasted, "has a '# Your Task' heading");
});

test("wrapped override, typed before the block and first line inside it", () => {
  assert.ok(classifyPrompt(`override:\n${wrap(TASK)}`).override);
  assert.ok(classifyPrompt(`override: do it here\n${wrap(TASK)}`).override);
  assert.ok(classifyPrompt(wrap(`override:\n${TASK}`)).override);
  assert.ok(classifyPrompt(wrap("override: just this")).override);
  assert.ok(!classifyPrompt(wrap(TASK)).override);
  // An unknown wrapper must not be able to swallow an override either.
  assert.ok(classifyPrompt('<attachment id="q">override: go</attachment>').override);
});

test("typed text plus a wrapped block", () => {
  const c = classifyPrompt(`Here is the next step, ignore the last one.\n${wrap(TASK)}\nthanks`);
  assert.equal(c.tag, "claims-wq7-s7f-p8wz");
  assert.ok(!c.override);
  assert.ok(c.pasted);
});

test("short replies pass, wrapped or not", () => {
  for (const s of ["yes", "no drift", "confirmed, no drift", "go"]) {
    assert.equal(classifyPrompt(s).pasted, null, s);
    assert.equal(classifyPrompt(wrap(s)).pasted, null, `wrapped: ${s}`);
  }
});

test("the wrapper alone does not push a short reply over the thresholds", () => {
  // 380 characters of content: under the 400 limit, over it if the tags counted.
  const body = "x".repeat(380);
  assert.equal(classifyPrompt(wrap(body)).pasted, null);
  assert.ok(classifyPrompt(wrap("x".repeat(420))).pasted);
});

test("wrapper-only paste reads as empty", () => {
  assert.equal(classifyPrompt(wrap("")).text.trim(), "");
});

test("long and multi-line untagged prompts still block", () => {
  assert.ok(classifyPrompt("a\nb\nc\nd").pasted);
  assert.ok(classifyPrompt("x".repeat(401)).pasted);
});
