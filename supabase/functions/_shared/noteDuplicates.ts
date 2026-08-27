// Duplicate-pitch rule — Deno/TS port of src/sam/lib/noteDuplicates.js.
//
// Spec M2: the rule must hold at every write path, and `append_sam_measures`
// is one of them. Deno can't import from `src/`, so this is a straight port —
// the same call Alex made for durations.ts on 2026-08-06 (duplicate plus a
// parity test, over build-time codegen).
//
// The predicate itself lives between the PARITY markers below. The parity test
// (src/sam/lib/noteDuplicates.test.js, "Deno-copy predicate parity") reads this
// file, strips the type annotations, evaluates what is between the markers, and
// runs a shared table of cases through BOTH implementations. A behavioural
// divergence fails there rather than shipping a rule the Edge Function enforces
// differently from the app.
//
// If you change the predicate here, MIRROR IT in src/sam/lib/noteDuplicates.js.
// Keep the marked block free of type annotations other than the ones already
// used — the stripper whitelists them deliberately, and an unrecognised one
// fails the parity test with an explanatory message rather than silently
// skipping the check.
//
// Only what the Edge Function needs is ported. `mergeDuplicatePitches` and the
// property union stay browser-side: this path rejects, it never repairs.

type NoteLike = { midi?: number; name?: string; tie?: string };

// PARITY-MARKER-START — do not remove, the parity test reads between markers
export function isContinuation(note?: NoteLike | null): boolean {
  return note?.tie === "end" || note?.tie === "both";
}

export function duplicatePitches(notes: unknown): number[] {
  if (!Array.isArray(notes) || notes.length < 2) return [];

  const freshPerMidi = new Map();
  for (const n of notes) {
    if (!n || typeof n.midi !== "number") continue;
    if (isContinuation(n)) continue;
    freshPerMidi.set(n.midi, (freshPerMidi.get(n.midi) || 0) + 1);
  }

  const out = [];
  for (const [midi, count] of freshPerMidi) {
    if (count > 1) out.push(midi);
  }
  return out;
}
// PARITY-MARKER-END

/** The sentence. Worded identically to the browser copy. */
export function duplicatePitchMessage(notes: NoteLike[], midi: number): string {
  const named = (notes || []).find((n) => n && n.midi === midi && n.name);
  const label = named ? `${named.name} (midi ${midi})` : `midi ${midi}`;
  return (
    `duplicate pitch ${label} — two notes in one event must not share a ` +
    `pitch unless one is a tie continuation.`
  );
}

/** Error lines for one event, or [] when it is clean. */
export function duplicatePitchErrors(
  notes: NoteLike[] | undefined,
  location: string,
): string[] {
  return duplicatePitches(notes).map(
    (midi) => `${location}: ${duplicatePitchMessage(notes || [], midi)}`,
  );
}

// ---------------------------------------------------------------------------
// Schema layer — the custom Ajv keyword the master schema declares on
// VoiceEvent.notes. Draft-07 cannot compare sibling array items, so the rule
// cannot be a plain constraint. See the browser copy's header for the full
// reasoning. Second layer: the explicit call in validateOneMeasure is primary.
// ---------------------------------------------------------------------------

export const DUPLICATE_PITCH_KEYWORD = "noDuplicatePitches";

// deno-lint-ignore no-explicit-any
export function registerDuplicatePitchKeyword(ajv: any): void {
  ajv.addKeyword({
    keyword: DUPLICATE_PITCH_KEYWORD,
    type: "array",
    schemaType: "boolean",
    errors: true,
    validate: function check(schemaValue: unknown, data: NoteLike[]) {
      if (schemaValue !== true) return true;
      const dupes = duplicatePitches(data);
      if (dupes.length === 0) return true;
      (check as unknown as { errors: unknown[] }).errors = dupes.map((midi) => ({
        keyword: DUPLICATE_PITCH_KEYWORD,
        message: duplicatePitchMessage(data, midi),
        params: {},   // the midi is already named in the message
      }));
      return false;
    },
  });
}
