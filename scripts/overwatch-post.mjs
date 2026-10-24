#!/usr/bin/env node
// overwatch-post: send the claims-block outbox to overwatch-ingest (Overwatch Step 7).
//
// Started detached by the claims script and the guard hook whenever they queue an event (scripts/lib/overwatch-post.mjs,
// kickSender); runs by hand too, with no arguments. Prints a one-line summary, and logs to
// <git common dir>/alfred-overwatch-outbox.jsonl.log. Never prints the secret.
// Set OVERWATCH_SENDER=off to stop events being queued and sent.

import { resolveRepo, withLock } from "./lib/claims-core.mjs";
import { readSettings, sendOutbox, takeSenderLock } from "./lib/overwatch-post.mjs";

let ctx;
try {
  ctx = resolveRepo(process.cwd());
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (!ctx.outboxFile) {
  console.log("No outbox here: this checkout has no scripts/overwatch-post.mjs, or CLAIMS_BLOCKS_FILE is set.");
  process.exit(0);
}

const release = takeSenderLock(ctx.outboxFile);
if (!release) {
  console.log("Another sender is running; it will send the outbox.");
  process.exit(0);
}
try {
  const s = await sendOutbox({
    outbox: ctx.outboxFile,
    withLock: (fn) => withLock(ctx, () => { fn(); return null; }),
    settings: readSettings(),
  });
  console.log(
    `sent ${s.sent} (inserted ${s.inserted}, updated ${s.updated}, unchanged ${s.unchanged}), dropped ${s.dropped}, kept ${s.kept}`,
  );
} finally {
  release();
}
