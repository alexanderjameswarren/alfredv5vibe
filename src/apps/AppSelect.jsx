import React from "react";
import AppIcon from "./AppIcon";
import { findApp } from "./appsApi";

const DEFAULT_SELECT = "w-full py-2 pr-3 min-h-[44px] border border-border rounded text-base";

/**
 * The App picker: the host form's native select, led by the chosen app's icon.
 * "" is "No app"; callers turn it into null before saving. `label={null}` when the
 * host renders its own label; `className` takes the host's select style.
 */
export default function AppSelect({
  apps = [],
  value,
  onChange,
  id = "app-select",
  label = "App",
  className = DEFAULT_SELECT,
}) {
  const chosen = findApp(apps, value);
  // A saved app missing from the list (still loading) keeps its option, so the
  // select never shows a value it cannot hold.
  const options = value && !chosen ? [...apps, { id: value, name: value }] : apps;

  return (
    <div>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-foreground mb-1">
          {label}
        </label>
      )}
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-primary">
          {chosen ? <AppIcon icon={chosen.icon} /> : null}
        </span>
        <select
          id={id}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className={`${className} ${chosen ? "pl-9" : "pl-3"}`}
        >
          <option value="">No app</option>
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
