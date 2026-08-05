// .mxl (zipped MusicXML) reader.
// Pure Node — no shell `unzip`, no dependency. Works identically on Windows,
// macOS and Linux. .mxl is a plain ZIP with either stored (0) or deflated (8)
// entries, so node:zlib is all that's needed.

import fs from "node:fs";
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  // EOCD is 22 bytes minimum and may be followed by a comment up to 64KB.
  const start = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("Not a zip archive (no end-of-central-directory record)");
}

/** Read every entry in a zip into a Map of filename -> Buffer. */
export function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    if (buf.readUInt32LE(localOff) === LOC_SIG) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Return the score XML from a .mxl, or the file contents for a plain
 * .xml / .musicxml. Honours META-INF/container.xml when present.
 */
export function readScoreXml(file) {
  if (/\.(xml|musicxml)$/i.test(file)) {
    return fs.readFileSync(file, "utf8");
  }

  const entries = readZip(fs.readFileSync(file));

  const container = entries.get("META-INF/container.xml");
  if (container) {
    const m = container.toString("utf8").match(/full-path="([^"]+)"/);
    if (m && entries.has(m[1])) return entries.get(m[1]).toString("utf8");
  }

  // Fallback: first .xml outside META-INF.
  for (const [name, data] of entries) {
    if (name.endsWith(".xml") && !name.startsWith("META-INF/")) {
      return data.toString("utf8");
    }
  }
  throw new Error(`No score XML found in ${file}`);
}
