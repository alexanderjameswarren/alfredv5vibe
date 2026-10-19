import React from "react";
import { X } from "lucide-react";

/** The one Cancel for pop-ups (Restructure P4): light neutral, X icon, beside the main button. */
export default function CancelButton({ onClick, disabled = false, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-lg bg-secondary hover:bg-secondary text-foreground text-sm shadow-sm disabled:opacity-60 ${className}`}
    >
      <X className="w-4 h-4" aria-hidden="true" />
      Cancel
    </button>
  );
}
