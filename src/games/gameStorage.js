// Local persistence for game variants.
//
// Mirrors src/utils/sortOrders.js: pure functions rather than a hook so they can
// be reasoned about without React, one key per scope, and every access wrapped.
// localStorage throws rather than returning null when storage is disabled or the
// quota is full, and a saved board is not worth taking the page down for.
//
// One key per variant, so each variant keeps its own save and adding a variant
// needs nothing here. Validation is the caller's, because only the variant knows
// what a sane board looks like for its own rules.

const PREFIX = "alfred.game.";

export const saveKeyFor = (variantId) => `${PREFIX}${variantId}`;

/**
 * Read a saved run, or null if there is nothing usable.
 *
 * Anything absent, unparseable or failing the caller's sanity check is
 * discarded whole and silently — a half-trusted board is worse than no board,
 * and there is nothing a player could do with an error about it anyway. The
 * validator is called inside the try as well: it is handed arbitrary parsed
 * JSON from any past build, so it must not be able to take the page down by
 * throwing on a shape it did not expect.
 */
export function readSave(variantId, validate) {
  let raw;
  try {
    raw = window.localStorage.getItem(saveKeyFor(variantId));
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist a run. Silently does nothing if storage is unavailable. */
export function writeSave(variantId, state) {
  try {
    window.localStorage.setItem(saveKeyFor(variantId), JSON.stringify(state));
  } catch {
    /* not saved; the run continues in memory for this session */
  }
}

/** Drop a saved run. Used when a variant starts over from scratch. */
export function clearSave(variantId) {
  try {
    window.localStorage.removeItem(saveKeyFor(variantId));
  } catch {
    /* nothing to remove, or storage is gone; either way there is no recourse */
  }
}
