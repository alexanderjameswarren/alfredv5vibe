import fs from "fs";
import path from "path";

/**
 * Chrome's PWA installability criteria, checked against the real files.
 *
 * ── The failure this exists to catch ───────────────────────────────────────
 *
 * `manifest.json` declared its 192 and 512 icons as `apple-touch-icon.png`,
 * which is really **180x180**. Chrome validates the ACTUAL decoded dimensions
 * against the declared `sizes` and discards entries that disagree, so it saw no
 * 192 icon and no 512 icon. Install silently degraded to "Install and create
 * shortcut" — a badged shortcut that opens in a Chrome tab, not a standalone
 * app. Nothing 404s and nothing errors; the manifest simply is not believed.
 *
 * Reading the declared sizes is not enough to catch that. These tests decode
 * the PNG headers.
 */

const publicDir = path.join(__dirname, "..", "public");
const manifest = JSON.parse(
  fs.readFileSync(path.join(publicDir, "manifest.json"), "utf8")
);
const indexHtml = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");

/** Width and height straight out of a PNG's IHDR chunk. */
function pngSize(file) {
  const buf = fs.readFileSync(path.join(publicDir, file));
  const isPng = buf.slice(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (!isPng || buf.slice(12, 16).toString() !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const pngIcons = (manifest.icons || []).filter((i) => i.type === "image/png");

describe("every manifest icon actually exists", () => {
  it.each((manifest.icons || []).map((i) => [i.src]))("%s is present", (src) => {
    // A 404 on the 512 icon fails installability silently.
    expect(fs.existsSync(path.join(publicDir, src))).toBe(true);
  });
});

describe("declared sizes match the real pixels", () => {
  it.each(pngIcons.map((i) => [i.src, i.sizes]))(
    "%s really is %s",
    (src, sizes) => {
      // THE bug: apple-touch-icon.png (180x180) was declared as both 192x192
      // and 512x512, so Chrome discarded both entries.
      const actual = pngSize(src);
      expect(actual).not.toBeNull();
      expect(`${actual.width}x${actual.height}`).toBe(sizes);
    }
  );
});

describe("Chrome's installability criteria", () => {
  it("has a name or a short_name, and neither is empty", () => {
    // The unlinked site.webmanifest had both empty, which would have failed
    // this on its own had it ever been linked.
    const named = manifest.name || manifest.short_name;
    expect(typeof named).toBe("string");
    expect(named.length).toBeGreaterThan(0);
  });

  it("uses an installable display mode", () => {
    expect(["standalone", "fullscreen", "minimal-ui"]).toContain(manifest.display);
  });

  it("declares a start_url", () => {
    expect(typeof manifest.start_url).toBe("string");
    expect(manifest.start_url.length).toBeGreaterThan(0);
  });

  it("has a 192px icon whose purpose includes 'any'", () => {
    // A maskable-ONLY icon set does not satisfy Chrome.
    const ok = pngIcons.some(
      (i) =>
        i.sizes === "192x192" &&
        (!i.purpose || i.purpose.split(/\s+/).includes("any"))
    );
    expect(ok).toBe(true);
  });

  it("has a 512px icon whose purpose includes 'any'", () => {
    const ok = pngIcons.some(
      (i) =>
        i.sizes === "512x512" &&
        (!i.purpose || i.purpose.split(/\s+/).includes("any"))
    );
    expect(ok).toBe(true);
  });
});

describe("exactly one manifest, and it is the one that is linked", () => {
  it("has no second manifest file to compete with", () => {
    // public/ held both manifest.json and an unlinked site.webmanifest whose
    // icons were the CORRECT ones. Two manifests meant the broken one shipped
    // while the good one was never fetched.
    const manifests = fs
      .readdirSync(publicDir)
      .filter((f) => f.endsWith(".webmanifest") || f === "manifest.json");
    expect(manifests).toEqual(["manifest.json"]);
  });

  it("is linked exactly once from index.html", () => {
    const links = indexHtml.match(/<link[^>]+rel="manifest"[^>]*>/g) || [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("manifest.json");
  });
});

describe("no icon link points at a file that is not there", () => {
  it("every local icon href in index.html resolves", () => {
    // index.html linked %PUBLIC_URL%/logo192.png, which does not exist.
    const hrefs = [...indexHtml.matchAll(/<link[^>]+rel="(?:apple-touch-)?icon"[^>]+href="([^"]+)"/g)]
      .map((m) => m[1].replace("%PUBLIC_URL%", "").replace(/^\//, ""));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect({ href, exists: fs.existsSync(path.join(publicDir, href)) }).toEqual({
        href,
        exists: true,
      });
    }
  });
});
