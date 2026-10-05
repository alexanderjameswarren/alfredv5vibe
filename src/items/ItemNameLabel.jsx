import React from "react";

/**
 * An item's name, or an honest stand-in when there isn't one.
 *
 * Two situations produce a missing name and the client cannot tell them apart:
 * the `items` row was deleted, or it is unreadable to whoever is looking. An
 * item is readable through ownership or a shared context — collection
 * membership grants nothing — so an item added without a context is invisible
 * to the other person even inside a shared collection. The wording commits to
 * neither cause.
 *
 * Four callers, two provenances: the recently-removed panel and the history
 * view pass the removal record's `item_name` snapshot; the collection detail
 * list and the execution checklist pass a live lookup that may find nothing.
 * The reader should not have to care which.
 */
export default function ItemNameLabel({ name }) {
  if (name) return <>{name}</>;
  return <span className="italic text-muted-foreground">⚠ Item unavailable</span>;
}
