import fs from "fs";
import path from "path";
import crypto from "crypto";
import { EXPECTED_SW_VERSION } from "./swVersion";

const swPath = path.join(__dirname, "..", "..", "public", "notify-sw.js");
const source = fs.readFileSync(swPath, "utf8");

/**
 * The content of the worker with its version line removed.
 *
 * Hashing this rather than the whole file is what makes the lock meaningful:
 * bumping the version changes the file but not this, so a deliberate bump does
 * not itself trip the guard.
 */
const bodyHash = crypto
  .createHash("sha256")
  .update(source.replace(/const SW_VERSION = '[^']*';/, ""))
  .digest("hex");

// 🛑 WHEN THIS TEST FAILS, YOU CHANGED THE WORKER.
//
// Do BOTH of these, then paste the new hash from the failure message here:
//   1. bump SW_VERSION in public/notify-sw.js
//   2. bump EXPECTED_SW_VERSION in src/utils/swVersion.js to the same value
//
// The point is that a worker change without a version bump would report "up to
// date" on a phone while running different code — which is the exact failure
// this whole mechanism exists to detect. Updating the hash without bumping the
// version defeats it.
const LOCKED_BODY_HASH =
  "d74694bf44b38e2df41e8f53d57be49f837ff037f4fe91d277118e15140e503a";
const LOCKED_VERSION = "2026-09-09a";

describe("the worker version is honest about what is deployed", () => {
  it("declares a version", () => {
    expect(source).toMatch(/const SW_VERSION = '[^']+';/);
  });

  it("matches EXPECTED_SW_VERSION in the app", () => {
    // A twin site: the worker cannot be imported from src/, so the constant is
    // duplicated. If they drift, the diagnostic reports a false mismatch — or
    // worse, a false match.
    const declared = source.match(/const SW_VERSION = '([^']+)';/)[1];
    expect(declared).toBe(EXPECTED_SW_VERSION);
  });

  it("answers a version request, so a phone can ask it", () => {
    expect(source).toContain("'sw-version'");
    expect(source).toContain("event.ports[0].postMessage");
  });

  it("was version-bumped along with its last content change", () => {
    // The lock. See the comment above LOCKED_BODY_HASH before changing it.
    if (bodyHash !== LOCKED_BODY_HASH) {
      throw new Error(
        `public/notify-sw.js changed.\n\n` +
          `  Bump SW_VERSION in public/notify-sw.js AND EXPECTED_SW_VERSION in\n` +
          `  src/utils/swVersion.js to the same NEW value, then set\n\n` +
          `    LOCKED_BODY_HASH = "${bodyHash}"\n` +
          `    LOCKED_VERSION   = "<the new version>"\n\n` +
          `  in this file. Current version is "${EXPECTED_SW_VERSION}"` +
          (EXPECTED_SW_VERSION === LOCKED_VERSION
            ? ", which has NOT been bumped."
            : ", which has been bumped.")
      );
    }
    expect(bodyHash).toBe(LOCKED_BODY_HASH);
  });
});

describe("the deep link path the worker owns", () => {
  // The failure this round: the payload carried the URL, the route worked when
  // pasted, and tapping still opened the home page — because the running worker
  // predated the change that puts the URL into notification.data.
  it("puts the payload url into notification DATA", () => {
    // `data` is the only part of a notification that survives into the
    // notificationclick handler, which runs as a separate worker invocation.
    expect(source).toMatch(/data:\s*\{\s*url:\s*payload\.url/);
  });

  it("reads it back on click rather than hardcoding '/'", () => {
    expect(source).toMatch(/event\.notification\.data\s*&&\s*event\.notification\.data\.url/);
  });

  it("still has no fetch handler", () => {
    expect(source).not.toContain("addEventListener('fetch'");
  });
});

describe("the closed-app landing fallback", () => {
  // clients.openWindow() cannot be relied on to control the landing route in an
  // installed PWA on Android: the OS launches the app at the manifest's
  // start_url and the requested URL is advisory. With Alfred already open the
  // worker navigates an existing window instead, which is why only the closed
  // path failed.
  it("records where it wanted to go before launching", () => {
    expect(source).toContain("recordPendingNavigation");
    expect(source).toContain("pendingNavigation");
  });

  it("awaits the record so it is durable before the app can boot", () => {
    expect(source).toMatch(/await recordPendingNavigation\(path\)/);
  });

  it("records ONLY on the closed path, never when a window is navigated", () => {
    // A record left behind on the open path could only be consumed by some
    // later, unrelated launch.
    const clickHandler = source.slice(source.indexOf("addEventListener('notificationclick'"));
    const navigateAt = clickHandler.indexOf("target.navigate(absolute)");
    const recordAt = clickHandler.indexOf("recordPendingNavigation(path)");
    expect(navigateAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(navigateAt);
  });

  it("passes an ABSOLUTE url to openWindow", () => {
    // Some Chrome versions handle a bare path badly here. The origin comes from
    // self.location, so there is still no setting to get wrong.
    expect(source).toMatch(/new URL\(path, self\.location\.origin\)/);
    expect(source).toMatch(/openWindow\(absolute\)/);
  });
});
