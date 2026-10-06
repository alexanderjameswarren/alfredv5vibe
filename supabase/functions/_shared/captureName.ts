// deno-lint-ignore-file
// @ts-nocheck — the twin body below is plain JS, kept byte-identical to the browser copy.
/**
 * Splits a capture into a short name and the rest, so a paragraph never becomes
 * a name. First line, else first sentence, else a word boundary near MAX.
 *
 * TWIN FILE: src/utils/captureName.js. The code between the twin markers must
 * be byte-identical in both; src/utils/captureName.test.js checks it.
 */

// --- twin body start ---
const CAPTURE_NAME_MAX = 80;

function splitLine(line) {
  if (line.length <= CAPTURE_NAME_MAX) return { name: line, rest: "" };
  const sentence = /[.!?](?=\s)/.exec(line);
  if (sentence && sentence.index > 0 && sentence.index < CAPTURE_NAME_MAX) {
    const end = line[sentence.index] === "." ? sentence.index : sentence.index + 1;
    return { name: line.slice(0, end).trim(), rest: line.slice(sentence.index + 1).trim() };
  }
  const space = line.lastIndexOf(" ", CAPTURE_NAME_MAX);
  const cut = space > 0 ? space : CAPTURE_NAME_MAX;
  return { name: line.slice(0, cut).trim(), rest: line.slice(cut).trim() };
}

function splitCaptureNameBody(text) {
  const t = String(text == null ? "" : text).trim();
  const newline = t.search(/\r?\n/);
  const firstLine = newline === -1 ? t : t.slice(0, newline).trim();
  const after = newline === -1 ? "" : t.slice(newline).trim();
  const head = splitLine(firstLine);
  const rest = [head.rest, after].filter(Boolean).join("\n");
  return { name: head.name, rest };
}
// --- twin body end ---

export function splitCaptureName(text: string | null | undefined): { name: string; rest: string } {
  return splitCaptureNameBody(text);
}

export { CAPTURE_NAME_MAX };
