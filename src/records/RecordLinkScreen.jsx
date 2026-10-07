import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { recordDestination } from "./recordRoutes";
import GenericRecordPage from "./GenericRecordPage";

const defaultResolve = (id) => supabase.rpc("resolve_record", { p_id: id });

// The /<id> screen. Resolves the id, then either hands a destination to
// `onOpen` (which navigates with replace) or renders the generic / not-found page.
// `lookup` is Alfred's loaded state; see recordRoutes.js.
export default function RecordLinkScreen({ recordId, onOpen, lookup, resolve = defaultResolve }) {
  const [state, setState] = useState({ id: null, result: null, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await resolve(recordId);
      if (cancelled) return;
      setState({ id: recordId, result: data ?? null, error: error?.message ?? null });
      const dest = error ? null : recordDestination(data, lookup);
      if (dest && dest.kind !== "generic" && dest.kind !== "missing") onOpen(dest);
    })();
    return () => {
      cancelled = true;
    };
  }, [recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.id !== recordId) {
    return <p className="text-muted-foreground">Looking up this record…</p>;
  }
  if (state.error) {
    return <p className="text-foreground">Could not look up this ID: {state.error}</p>;
  }
  const dest = recordDestination(state.result, lookup);
  if (dest.kind === "missing") {
    return <h1 className="text-xl font-semibold text-foreground">No record with this ID</h1>;
  }
  if (dest.kind === "generic") return <GenericRecordPage result={state.result} />;
  return <p className="text-muted-foreground">Opening…</p>;
}
