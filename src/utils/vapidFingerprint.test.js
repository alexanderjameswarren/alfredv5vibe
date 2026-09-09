import fs from "fs";
import path from "path";
import { vapidFingerprint, describeVapidKeyBytes } from "./vapidFingerprint";

// A real VAPID public key shape: 87 base64url chars, decoding to 65 bytes.
const REAL = "BH7jG1-LXyDsU1cnCe_kc9G_ueqcObp-ew01zDVbUc0d7cj6MytafHJs_WFOnhYu6gLZznySq1lflrjZL8LFsKU";
const OTHER = "BBLj3Mm38atFDxZ9X7bBW7nexhpwdlMslhl82ql12fVOwiR99Uo-qlVDak6wbVWv-qpLG36wnvbLF9UkaP7ZWKw";

describe("vapidFingerprint", () => {
  it("shows the prefix AND the suffix", () => {
    // Prefix alone cannot separate two keys generated in the same session, and
    // length alone separates nothing — every valid key is 87 characters.
    expect(vapidFingerprint(REAL)).toBe("BH7jG1-L…ZL8LFsKU (87 chars)");
  });

  it("never reveals the whole key", () => {
    expect(vapidFingerprint(REAL)).not.toContain(REAL);
    expect(vapidFingerprint(REAL).length).toBeLessThan(40);
  });

  it("distinguishes two keys of the SAME length", () => {
    // The whole point: both are 87 chars, so length cannot tell them apart.
    expect(REAL.length).toBe(OTHER.length);
    expect(vapidFingerprint(REAL)).not.toBe(vapidFingerprint(OTHER));
  });

  it("is stable, so client and server strings compare directly", () => {
    expect(vapidFingerprint(REAL)).toBe(vapidFingerprint(REAL));
  });

  it("reports a missing key rather than throwing", () => {
    expect(vapidFingerprint("")).toBe("(none)");
    expect(vapidFingerprint(undefined)).toBe("(none)");
    expect(vapidFingerprint(null)).toBe("(none)");
  });

  it("does not try to abbreviate something too short to abbreviate", () => {
    expect(vapidFingerprint("abc")).toBe("abc (3 chars)");
  });
});

describe("describeVapidKeyBytes — is it a KEY, or just 87 characters?", () => {
  const valid = new Uint8Array(65);
  valid[0] = 0x04;

  it("accepts an uncompressed P-256 point", () => {
    const r = describeVapidKeyBytes(valid);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/65 bytes/);
  });

  it("rejects the right length with the wrong marker", () => {
    const wrongMarker = new Uint8Array(65);
    wrongMarker[0] = 0x02; // a compressed point — not what subscribe wants
    const r = describeVapidKeyBytes(wrongMarker);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/expected 0x04/);
  });

  it("rejects a truncated key", () => {
    const r = describeVapidKeyBytes(new Uint8Array(64));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/64 bytes, expected 65/);
  });

  it("reports rather than throwing when the decode failed entirely", () => {
    expect(describeVapidKeyBytes(null).ok).toBe(false);
    expect(describeVapidKeyBytes(undefined).ok).toBe(false);
  });
});

describe("client and server use ONE formatter", () => {
  // If the two sides formatted differently, a matching pair would look
  // mismatched — the diagnostic would lie in exactly the situation it exists
  // for. Both edge functions import this module rather than reimplementing it.
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", "..", "supabase", "functions", rel), "utf8");

  it.each([["notify-dispatch"], ["push-send"]])(
    "%s imports the shared formatter",
    (fn) => {
      expect(read(`${fn}/index.ts`)).toContain(
        'from "../../../src/utils/vapidFingerprint.js"'
      );
    }
  );

  it.each([["notify-dispatch"], ["push-send"]])(
    "%s reports the key it signed with",
    (fn) => {
      expect(read(`${fn}/index.ts`)).toContain("vapid_public_key: signingKeyFingerprint");
    }
  );

  it.each([["notify-dispatch"], ["push-send"]])(
    "%s derives that from the key actually passed to setVapidDetails",
    (fn) => {
      // Reporting a key other than the one that signed would be worse than
      // reporting none: it would clear a real mismatch.
      const src = read(`${fn}/index.ts`);
      expect(src).toMatch(/signingKeyFingerprint = vapidFingerprint\(/);
    }
  );
});
