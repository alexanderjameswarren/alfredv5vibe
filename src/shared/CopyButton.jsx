import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

export const COPIED_MS = 1500;

/**
 * The one Copy control (Restructure P4). `getText()` gives what to copy. On success
 * the icon turns into a check mark for a moment; no toast. A refused clipboard is
 * still said out loud, never silent.
 *   size "small": a faint icon after a detail page's title, always visible (phones
 *     have no hover).
 *   size "large": a labelled button for cards (`className` styles it).
 */
export default function CopyButton({ getText, size = "small", label = "Copy", title, className = "" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(e) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText());
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch (err) {
      console.error("[CopyButton]", err);
      window.alert("Could not copy. The browser refused the clipboard.");
    }
  }

  const Icon = copied ? Check : Copy;
  if (size === "large") {
    return (
      <button type="button" onClick={copy} title={title} className={className}>
        <Icon className="w-4 h-4" aria-hidden="true" />
        {copied ? "Copied" : label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={title || label}
      className={`inline-flex items-center justify-center shrink-0 min-h-[32px] min-w-[32px] rounded text-muted-foreground/60 hover:text-foreground ${className}`}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}
