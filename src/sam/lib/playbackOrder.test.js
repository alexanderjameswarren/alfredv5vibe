// Playback-order resolver unit tests. Run via `npm test` (Jest, CRA).
//
// The resolver takes an array of MusicXML <measure> DOM elements and
// returns a flat playback-order array of 0-based source indices. Spec §M4
// requires:
//   1. Forward and backward repeats respected
//   2. Voltas (<ending number="…">) apply per repeat pass
//   3. Borrowed pairs at a repeat seam (Für Elise m1/m9) route correctly:
//      the pickup replays and the first ending is skipped on the second pass
//   4. Idempotent — a pre-expanded score (no repeat markers) returns
//      identity, and re-running on the same input returns the same order

import { resolvePlaybackOrder } from "./playbackOrder";

// -- helpers ----------------------------------------------------------------

const parse = (xml) => {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  return [...doc.querySelectorAll("measure")];
};

const bare = (n) =>
  Array.from({ length: n }, (_, i) => `<measure number="${i + 1}"></measure>`).join("");

const wrap = (measures) => `<?xml version="1.0"?><score><part>${measures}</part></score>`;

// -- tests ------------------------------------------------------------------

describe("resolvePlaybackOrder — identity cases", () => {
  test("no repeats, no navigation returns 0..n-1", () => {
    const els = parse(wrap(bare(6)));
    const { order, hasRepeats, hasNavigation } = resolvePlaybackOrder(els);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(hasRepeats).toBe(false);
    expect(hasNavigation).toBe(false);
  });

  test("empty measure list returns empty order", () => {
    expect(resolvePlaybackOrder([]).order).toEqual([]);
  });
});

describe("resolvePlaybackOrder — repeats", () => {
  test("single backward-repeat plays the whole span twice", () => {
    // m1..m4, backward repeat on m4 → 0 1 2 3 0 1 2 3
    const xml = wrap(
      `<measure number="1"></measure>
       <measure number="2"></measure>
       <measure number="3"></measure>
       <measure number="4"><barline><repeat direction="backward"/></barline></measure>`
    );
    const { order, hasRepeats } = resolvePlaybackOrder(parse(xml));
    expect(order).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(hasRepeats).toBe(true);
  });

  test("forward-repeat + backward-repeat: only the marked span replays", () => {
    // m1 (intro), m2 forward-repeat, m3, m4 backward-repeat, m5 (coda tail)
    // → 0 1 2 3 1 2 3 4
    const xml = wrap(
      `<measure number="1"></measure>
       <measure number="2"><barline><repeat direction="forward"/></barline></measure>
       <measure number="3"></measure>
       <measure number="4"><barline><repeat direction="backward"/></barline></measure>
       <measure number="5"></measure>`
    );
    const { order } = resolvePlaybackOrder(parse(xml));
    expect(order).toEqual([0, 1, 2, 3, 1, 2, 3, 4]);
  });

  test("repeat times=3 replays span twice more (three total passes)", () => {
    const xml = wrap(
      `<measure number="1"></measure>
       <measure number="2"><barline><repeat direction="backward" times="3"/></barline></measure>`
    );
    const { order } = resolvePlaybackOrder(parse(xml));
    expect(order).toEqual([0, 1, 0, 1, 0, 1]);
  });
});

describe("resolvePlaybackOrder — voltas", () => {
  test("first / second ending: pass 1 plays ending 1, pass 2 skips to ending 2", () => {
    // Structure: m1 m2 [ending1 m3 m4 backward-repeat] [ending2 m5]
    // Expected: 0 1 2 3   (pass 1: through m4, then repeat to m1)
    //           0 1 4     (pass 2: skip ending1, play ending2)
    const xml = wrap(
      `<measure number="1"></measure>
       <measure number="2"></measure>
       <measure number="3"><barline><ending number="1" type="start"/></barline></measure>
       <measure number="4"><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
       <measure number="5"><barline><ending number="2" type="start"/></barline><barline location="right"><ending number="2" type="stop"/></barline></measure>`
    );
    const { order } = resolvePlaybackOrder(parse(xml));
    expect(order).toEqual([0, 1, 2, 3, 0, 1, 4]);
  });

  test("borrowed pair pattern (Für Elise mini): pickup replays, first ending skipped on pass 2", () => {
    // Mirrors the Für Elise m1/m9 shape at a smaller scale.
    // Source indices:
    //   0  pickup (implicit anacrusis)
    //   1..4  body
    //   5  first-ending start + stop + backward-repeat (borrowed partner)
    //   6  second-ending start + stop (completes the borrowed bar)
    //   7  post-repeat tail
    // Alex's spec says the pickup REPLAYS on the repeat. This works
    // because Für Elise has no forward-repeat marker, so repeatStart
    // stays at the default 0 and the backward-repeat jumps to the pickup.
    // Expected: pass 1 = 0..5, pass 2 skips index 5 (ending "1") to index 6,
    // then tail:   0 1 2 3 4 5 | 0 1 2 3 4 | 6 | 7
    const xml = wrap(
      `<measure number="0"></measure>
       <measure number="1"></measure>
       <measure number="2"></measure>
       <measure number="3"></measure>
       <measure number="4"></measure>
       <measure number="5"><barline><ending number="1" type="start"/></barline><barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
       <measure number="6"><barline><ending number="2" type="start"/></barline><barline location="right"><ending number="2" type="stop"/></barline></measure>
       <measure number="7"></measure>`
    );
    const { order } = resolvePlaybackOrder(parse(xml));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 6, 7]);
    // The pickup (index 0) appears twice — that's the Alex-verified behaviour.
    expect(order.filter((i) => i === 0)).toHaveLength(2);
  });
});

describe("resolvePlaybackOrder — idempotence (workshop pre-expanded scores)", () => {
  test("no repeat markers → identity order; re-parse of the same input → identical order", () => {
    // A workshop that pre-expands a score to sounding order strips the
    // repeat and ending markers. Running the resolver on such an XML must
    // return the identity, and running it a second time must return the
    // same identity — flatten(flatten(x)) === flatten(x).
    const xml = wrap(bare(20));
    const first = resolvePlaybackOrder(parse(xml));
    const second = resolvePlaybackOrder(parse(xml));
    expect(first.order).toEqual([...Array(20).keys()]);
    expect(second.order).toEqual(first.order);
    expect(first.hasRepeats).toBe(false);
  });

  test("navigation flags reflect input, not resolver state", () => {
    // Fresh DOM each call, same result — the resolver holds no state.
    const xml = wrap(
      `<measure number="1"></measure>
       <measure number="2"><barline><repeat direction="backward"/></barline></measure>`
    );
    const a = resolvePlaybackOrder(parse(xml));
    const b = resolvePlaybackOrder(parse(xml));
    expect(a.hasRepeats).toBe(b.hasRepeats);
    expect(a.order).toEqual(b.order);
  });
});

describe("resolvePlaybackOrder — navigation detection", () => {
  test("D.S. al fine sets hasNavigation and reports the marks", () => {
    const xml = wrap(
      `<measure number="1"><direction><sound segno="1"/></direction></measure>
       <measure number="2"></measure>
       <measure number="3"><direction><sound dalsegno="1"/></direction></measure>
       <measure number="4"><direction><sound fine="1"/></direction></measure>`
    );
    const { hasNavigation, navMarks } = resolvePlaybackOrder(parse(xml));
    expect(hasNavigation).toBe(true);
    expect(navMarks.map((n) => n.measure)).toEqual([1, 3, 4]);
  });
});
