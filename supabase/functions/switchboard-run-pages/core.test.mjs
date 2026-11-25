// switchboard-run-pages: routing, refusals, the database's refusal text passed through, the note cap, simulations
// marked and the review answers, against fake dependencies (no network). The helper's routes are gone (option A, s12).
// Run: node --experimental-strip-types --test supabase/functions/switchboard-run-pages/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, lineText, resultLine } from "./core.ts";

const USER = "26f0707f-b586-4a3e-841c-8c313d6ab1e5";
const TOKEN = "a".repeat(64);
const LINK = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";
const READY = { answer: "running", panel: true, helper: true, extension_version: "1.3.0" };

function fakes(over = {}) {
  const calls = { rpc: [], answers: [] };
  const deps = {
    userId: USER,
    authUser: async (jwt) => (jwt === "good" ? USER : jwt === "other" ? "someone-else" : null),
    rpcAsUser: async (jwt, fn, args) => {
      calls.rpc.push({ jwt, fn, args });
      if (fn === "switchboard_run_preview") return { data: { link_id: LINK, request: { simulation: false }, review: null }, error: null };
      if (fn === "switchboard_consume_run_link") return { data: { consumed: true, simulated: false, link_id: LINK, mode: args.p_mode, action_id: "act-1" }, error: null };
      if (fn === "switchboard_retry_run") return { data: { resent: true, link_id: LINK, action_id: "act-2" }, error: null };
      if (fn === "switchboard_cancel_run_link") return { data: { cancelled: true, link_id: LINK, reason: args.p_reason }, error: null };
      return { data: null, error: { message: "unexpected", code: "XX000" } };
    },
    answerReview: async (id, patch) => (calls.answers.push({ id, patch }), true),
    now: () => new Date("2026-11-23T15:00:00.000Z"),
    ...over,
  };
  return { deps, calls };
}

const post = (route, body, headers = {}) => new Request(`https://x.example/functions/v1/switchboard-run-pages/${route}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const asAlex = { authorization: "Bearer good" };
const read = async (res) => ({ status: res.status, body: await res.json() });

test("routing: unknown routes 404, GET 405, OPTIONS gets CORS on the page routes", async () => {
  const { deps } = fakes();
  assert.equal((await handle(post("nope", {}), deps)).status, 404);
  assert.equal((await handle(new Request("https://x.example/functions/v1/switchboard-run-pages/preview"), deps)).status, 405);
  const opt = await handle(new Request("https://x.example/functions/v1/switchboard-run-pages/approve", { method: "OPTIONS" }), deps);
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
});

test("the helper's old routes are gone (option A, s12): /evidence and /sample are 404, with or without a key", async () => {
  const { deps, calls } = fakes();
  for (const route of ["evidence", "sample"]) {
    for (const headers of [{}, asAlex, { "x-switchboard-pickup-key": "k".repeat(48) }]) {
      assert.equal((await handle(post(route, { link_id: LINK }, headers), deps)).status, 404);
    }
    assert.equal((await handle(new Request(`https://x.example/functions/v1/switchboard-run-pages/${route}`, { method: "OPTIONS" }), deps)).status, 404);
  }
  assert.equal(calls.rpc.length + calls.answers.length, 0);
});

test("no route works without a valid JWT of Alex's; nothing reaches the database", async () => {
  for (const route of ["preview", "approve", "rerun", "resend", "cancel", "review"]) {
    for (const headers of [{}, { authorization: "Bearer bad" }, { authorization: "Bearer other" }, { authorization: "good" }]) {
      const { deps, calls } = fakes();
      const { status, body } = await read(await handle(post(route, { token: TOKEN }, headers), deps));
      assert.equal(status, 401, `${route} ${JSON.stringify(headers)}`);
      assert.deepEqual(body, { ok: false, error: "unauthorized" });
      assert.equal(calls.rpc.length, 0);
    }
  }
});

test("bad input is refused before any call", async () => {
  const { deps, calls } = fakes();
  assert.equal((await handle(post("preview", { token: "short" }, asAlex), deps)).status, 400);
  assert.equal((await handle(post("approve", { token: TOKEN }, asAlex), deps)).status, 400);
  assert.equal((await handle(post("approve", { token: TOKEN, fingerprint: "f", count: 1.5 }, asAlex), deps)).status, 400);
  assert.equal((await handle(post("cancel", { token: TOKEN, reason: 5 }, asAlex), deps)).status, 400);
  assert.equal((await handle(new Request("https://x.example/f/preview", { method: "POST", headers: asAlex, body: "[" }), deps)).status, 400);
  assert.equal(calls.rpc.length, 0);
});

test("approve and rerun call consume with Alex's JWT, the page's values and only the desktop's own keys", async () => {
  const { deps, calls } = fakes();
  const a = await read(await handle(post("approve", { token: TOKEN, fingerprint: "fp", count: 45, desktop: { ...READY, extra: "x" } }, asAlex), deps));
  assert.equal(a.status, 200);
  assert.equal(a.body.line, `run ${LINK}`);
  assert.deepEqual(calls.rpc[0], { jwt: "good", fn: "switchboard_consume_run_link",
    args: { p_token: TOKEN, p_fingerprint: "fp", p_desktop: READY, p_count: 45, p_mode: "approve" } });
  const r = await read(await handle(post("rerun", { token: TOKEN, fingerprint: "fp", desktop: READY, count: 99 }, asAlex), deps));
  assert.equal(r.body.mode, "rerun");
  assert.equal(calls.rpc[1].args.p_count, null);
});

test("a correction's Approve (as_rerun) posts run <id> reruns; the expired rerun and a write keep the bare line", async () => {
  const reply = (mode, asRerun) => fakes({
    rpcAsUser: async () => ({ data: { consumed: true, simulated: false, link_id: LINK, mode, action_id: LINK, as_rerun: asRerun }, error: null }),
  }).deps;
  const body = { token: TOKEN, fingerprint: "fp", desktop: READY, count: 45 };
  assert.equal((await read(await handle(post("approve", body, asAlex), reply("approve", true)))).body.line, `run ${LINK} reruns`);
  assert.equal((await read(await handle(post("approve", body, asAlex), reply("approve", false)))).body.line, `run ${LINK}`);
  assert.equal((await read(await handle(post("rerun", body, asAlex), reply("rerun", true)))).body.line, `run ${LINK}`);
});

test("the database's refusal comes back word for word, with a status from its code", async () => {
  const message = "switchboard_consume_run_link: the checks expired at 2026-11-22; run the pre-check and rehearsal again. Nothing was approved.";
  for (const [code, status] of [["55000", 409], ["P0002", 404], ["28000", 401], ["23514", 400]]) {
    const { deps } = fakes({ rpcAsUser: async () => ({ data: null, error: { message, code } }) });
    const { status: s, body } = await read(await handle(post("approve", { token: TOKEN, fingerprint: "fp", desktop: READY, count: 45 }, asAlex), deps));
    assert.equal(s, status);
    assert.equal(body.error, message);
    assert.equal(body.ok, false);
  }
});

test("a simulated run is accepted and marked; its line says SIMULATION", async () => {
  const { deps } = fakes({
    rpcAsUser: async () => ({ data: { consumed: true, simulated: true, link_id: LINK, mode: "approve", action_id: null }, error: null }),
  });
  const { body } = await read(await handle(post("approve", { token: TOKEN, fingerprint: "fp", desktop: READY, count: 45 }, asAlex), deps));
  assert.equal(body.simulated, true);
  assert.equal(body.line, `SIMULATION run ${LINK}`);
});

test("Don't run: the note is one line, capped at 200 with …, and the line carries it", async () => {
  const { deps, calls } = fakes();
  const { body } = await read(await handle(post("cancel", { token: TOKEN, reason: `${"x ".repeat(150)}\nend` }, asAlex), deps));
  const sent = calls.rpc.find((c) => c.fn === "switchboard_cancel_run_link").args.p_reason;
  assert.ok(sent.length <= 200 && sent.endsWith("…") && !sent.includes("\n"));
  assert.equal(body.line, `run ${LINK} cancelled: ${sent}`);
  const { deps: d2, calls: c2 } = fakes();
  const bare = await read(await handle(post("cancel", { token: TOKEN }, asAlex), d2));
  assert.equal(c2.rpc.find((c) => c.fn === "switchboard_cancel_run_link").args.p_reason, null);
  assert.equal(bare.body.line, `run ${LINK} cancelled`);
});

test("resend calls switchboard_retry_run and keeps the link id in its line", async () => {
  const { deps, calls } = fakes();
  const { body } = await read(await handle(post("resend", { token: TOKEN, fingerprint: "fp", desktop: READY }, asAlex), deps));
  assert.equal(calls.rpc[0].fn, "switchboard_retry_run");
  assert.equal(body.line, `run ${LINK} resent`);
});

const reviewPreview = (status = "open", over = {}) => ({
  link_id: LINK, request: { simulation: false },
  review: { id: "rev-1", status, findings: { for_you: [{ id: "y1" }, { id: "y2" }] }, ...over },
});
const reviewFakes = (preview) => fakes({
  rpcAsUser: async (jwt, fn) => (fn === "switchboard_run_preview" ? { data: preview, error: null } : { data: null, error: { message: "x" } }),
});

test("review: I reviewed needs every finding acknowledged and the desktop ready; the service write gets only the validated answer", async () => {
  let f = reviewFakes(reviewPreview());
  let r = await read(await handle(post("review", { token: TOKEN, answer: "reviewed", acks: { y1: {} }, desktop: READY }, asAlex), f.deps));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /acknowledge every/);
  f = reviewFakes(reviewPreview());
  r = await read(await handle(post("review", { token: TOKEN, answer: "reviewed", acks: { y1: {}, y2: {} } }, asAlex), f.deps));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /desktop is not ready/);
  f = reviewFakes(reviewPreview());
  r = await read(await handle(post("review", { token: TOKEN, answer: "reviewed", desktop: READY,
    acks: { y1: { note: "ok", extra: 1 }, y2: { note: "z".repeat(300) } } }, asAlex), f.deps));
  assert.equal(r.status, 200);
  assert.equal(r.body.line, `review ${LINK} reviewed`);
  const patch = f.calls.answers[0].patch;
  assert.equal(patch.status, "reviewed");
  assert.deepEqual(Object.keys(patch.acks), ["y1", "y2"]);
  assert.deepEqual(patch.acks.y1, { note: "ok" });
  assert.equal(patch.acks.y2.note.length, 200);
  assert.deepEqual(patch.answer, { kind: "reviewed", text: "", at: "2026-11-23T15:00:00.000Z" });
});

test("review: a question keeps it open and its line carries 200 characters; the full text (up to 1000) is kept", async () => {
  const f = reviewFakes(reviewPreview());
  const text = `Why ${"q".repeat(600)}`;
  const r = await read(await handle(post("review", { token: TOKEN, answer: "question", text }, asAlex), f.deps));
  assert.equal(f.calls.answers[0].patch.status, "open");
  assert.equal(f.calls.answers[0].patch.answer.text, text);
  assert.ok(r.body.line.startsWith(`review ${LINK} question: Why`));
  assert.equal(r.body.line.length, `review ${LINK} question: `.length + 200);
  assert.ok(r.body.line.endsWith("…"));
  const long = await read(await handle(post("review", { token: TOKEN, answer: "changes_required", text: "x".repeat(1001) }, asAlex), reviewFakes(reviewPreview()).deps));
  assert.equal(long.status, 400);
  const none = await read(await handle(post("review", { token: TOKEN, answer: "changes_required" }, asAlex), reviewFakes(reviewPreview()).deps));
  assert.equal(none.status, 400);
});

test("review: refused when superseded, already answered, not a review link, or acks name another finding", async () => {
  const sup = await read(await handle(post("review", { token: TOKEN, answer: "question", text: "q" }, asAlex), reviewFakes(reviewPreview("superseded")).deps));
  assert.equal(sup.status, 409);
  assert.equal(sup.body.error, "The code has changed since this review. A new review comes after the next rehearsal.");
  const done = await read(await handle(post("review", { token: TOKEN, answer: "question", text: "q" }, asAlex), reviewFakes(reviewPreview("reviewed")).deps));
  assert.equal(done.status, 409);
  const notReview = await read(await handle(post("review", { token: TOKEN, answer: "question", text: "q" }, asAlex), reviewFakes({ link_id: LINK, review: null }).deps));
  assert.equal(notReview.status, 400);
  const f = reviewFakes(reviewPreview());
  const bad = await read(await handle(post("review", { token: TOKEN, answer: "question", text: "q", acks: { y9: {} } }, asAlex), f.deps));
  assert.equal(bad.status, 400);
  assert.equal(f.calls.answers.length, 0);
});

test("review: a voided or no-longer-current link answers nothing; a lost race is refused", async () => {
  for (const link of [{ voided_at: "t", current: true }, { voided_at: null, current: false }]) {
    const f = reviewFakes({ ...reviewPreview(), link });
    const r = await read(await handle(post("review", { token: TOKEN, answer: "question", text: "q" }, asAlex), f.deps));
    assert.equal(r.status, 409);
    assert.equal(f.calls.answers.length, 0);
  }
  const lost = fakes({
    rpcAsUser: async () => ({ data: reviewPreview(), error: null }),
    answerReview: async () => false,
  });
  const r = await read(await handle(post("review", { token: TOKEN, answer: "question", text: "q" }, asAlex), lost.deps));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /changed while you answered/);
});

test("lineText and resultLine", () => {
  assert.equal(lineText("  a\n b  "), "a b");
  assert.equal(lineText("x".repeat(250)).length, 200);
  assert.equal(resultLine("run", LINK, " resent", true), `SIMULATION run ${LINK} resent`);
});
