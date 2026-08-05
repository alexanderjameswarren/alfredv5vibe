// MusicXML repeat / volta / D.S.-al-Coda resolution.
//
// Ported from tools/sam-tools/lib/xmlTruth.js (M4, spec §M4). This file is
// the parser's independent copy — truth already has its own so that a design
// error inside the resolver isn't invisible (both agree, both silently
// wrong). Duration math, pitch extraction, tuplet ratios, voice grouping,
// merge segmentation, hand assignment, and playback order all stay
// independent between parser and truth. Divergence between the two copies
// surfaces via findings, not by construction-forced agreement.
//
// Returns:
//   { order, hasRepeats, hasNavigation, navMarks }
// where `order` is an array of 0-based indices into `measEls`, in playback
// order. For a piece with no repeats and no navigation the order is
// [0, 1, ..., n-1] and the caller need not treat that case specially:
//   flatten(flatten(x)) === flatten(x)                              (idempotence)
// A workshop-produced pre-expanded score arrives with no repeat or ending
// markers, resolvePlaybackOrder returns the identity order, and running it
// a second time on the same input returns the identity again.

export function resolvePlaybackOrder(measEls) {
  const n = measEls.length;
  const info = measEls.map((m) => {
    const endings = [...m.querySelectorAll("ending")].map((e) => ({
      numbers: (e.getAttribute("number") || "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter(Boolean),
      type: e.getAttribute("type"),
    }));
    const sounds = [...m.querySelectorAll("sound")];
    const attr = (name) => sounds.map((s) => s.getAttribute(name)).find(Boolean) || null;
    return {
      forwardRepeat: !!m.querySelector('repeat[direction="forward"]'),
      backwardRepeat: !!m.querySelector('repeat[direction="backward"]'),
      repeatTimes: parseInt(
        m.querySelector('repeat[direction="backward"]')?.getAttribute("times") || "2",
        10
      ),
      endings,
      segno: !!attr("segno"),
      coda: !!attr("coda"),
      toCoda: !!attr("tocoda"),
      dalSegno: !!attr("dalsegno"),
      daCapo: !!attr("dacapo"),
      fine: !!attr("fine"),
    };
  });

  const segnoIdx = info.findIndex((i) => i.segno);
  const codaIdx = info.findIndex((i) => i.coda);

  const order = [];
  const passCount = new Map();
  let i = 0;
  let repeatStart = 0;
  let jumped = false;
  let honourToCoda = false;
  let guard = 0;

  while (i < n && guard++ < n * 12) {
    const m = info[i];
    if (m.forwardRepeat) repeatStart = i;

    // Volta: on a pass whose number isn't in this ending's list, skip past
    // the ending block. Ending `stop`/`discontinue` marks its last measure.
    const startEnding = m.endings.find((e) => e.type === "start");
    if (startEnding) {
      const pass = (passCount.get(repeatStart) || 0) + 1;
      if (!startEnding.numbers.includes(pass)) {
        let j = i;
        while (
          j < n &&
          !info[j].endings.some((e) => e.type === "stop" || e.type === "discontinue")
        ) {
          j++;
        }
        i = j + 1;
        continue;
      }
    }

    order.push(i);

    if (honourToCoda && m.toCoda && codaIdx >= 0) {
      i = codaIdx;
      honourToCoda = false;
      continue;
    }
    if (m.fine && jumped) break;

    if (m.backwardRepeat) {
      const taken = passCount.get(repeatStart) || 0;
      if (taken + 1 < m.repeatTimes) {
        passCount.set(repeatStart, taken + 1);
        i = repeatStart;
        continue;
      }
    }

    if (!jumped && (m.dalSegno || m.daCapo)) {
      jumped = true;
      honourToCoda = true;
      i = m.dalSegno && segnoIdx >= 0 ? segnoIdx : 0;
      continue;
    }

    i++;
  }

  return {
    order,
    hasRepeats: info.some((x) => x.forwardRepeat || x.backwardRepeat),
    hasNavigation: info.some(
      (x) => x.segno || x.coda || x.dalSegno || x.daCapo || x.toCoda || x.fine
    ),
    navMarks: info
      .map((x, idx) => ({ idx: idx + 1, ...x }))
      .filter((x) => x.segno || x.coda || x.dalSegno || x.daCapo || x.toCoda || x.fine)
      .map((x) => ({
        measure: x.idx,
        marks: ["segno", "coda", "toCoda", "dalSegno", "daCapo", "fine"].filter((k) => x[k]),
      })),
  };
}
