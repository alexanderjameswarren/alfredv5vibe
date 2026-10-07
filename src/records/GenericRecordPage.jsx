import React, { useState } from "react";

// Strings longer than this, and any jsonb or array, start collapsed.
export const LONG_TEXT = 200;

export function isLargeValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return true;
  return typeof value === "string" && value.length > LONG_TEXT;
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function Field({ name, value }) {
  const large = isLargeValue(value);
  const [open, setOpen] = useState(false);
  return (
    <div className="py-2 border-b border-border last:border-b-0">
      <dt className="text-xs font-medium text-muted-foreground">{name}</dt>
      <dd className="mt-0.5 text-sm text-foreground">
        {large && (
          <button
            type="button"
            className="text-xs text-primary underline"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide" : "Show"}
          </button>
        )}
        {(!large || open) && (
          <pre className="whitespace-pre-wrap break-words font-sans">{formatValue(value)}</pre>
        )}
      </dd>
    </div>
  );
}

// Read-only page for a record with no screen of its own.
export default function GenericRecordPage({ result }) {
  const { table, row, match_count: matchCount } = result;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold text-foreground">Record from {table}</h1>
      {matchCount > 1 && (
        <p className="text-sm text-muted-foreground">
          This ID matches {matchCount} records; showing the one from {table}.
        </p>
      )}
      <dl className="rounded-lg border border-border bg-card px-4">
        {Object.entries(row).map(([name, value]) => (
          <Field key={name} name={name} value={value} />
        ))}
      </dl>
    </div>
  );
}
