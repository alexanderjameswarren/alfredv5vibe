import React from "react";
import { viewToPath } from "./viewPaths";

// A navigation link that behaves like a link.
//
// Step 6 of docs/technical-spec-navigation-urls.md. Alfred's nav has always
// been <button onClick={...}>, which cannot be middle-clicked or
// Ctrl/Cmd-clicked into a new tab — those are browser behaviours attached to
// a real <a href>, and no amount of JavaScript reproduces them. So this
// renders a genuine anchor with a genuine address, and intervenes as little
// as possible.
//
// The two branches:
//
//   Modifier or middle click  -> do NOTHING. No preventDefault, no guard, no
//                                state writes. The browser opens its new tab
//                                and this tab is left completely untouched.
//   Plain left click          -> preventDefault, run the guard, then navigate
//                                in-place exactly as the old button did.
//
// The first branch is the feature. The second branch is what stops the
// feature from costing anything: turning a guarded button into a bare link
// without it would silently delete the unsaved-changes warning.
//
// Note that the guard deliberately does not run on a modified click. Nothing
// is navigating away in this tab, so the dirty form is not at risk, and
// prompting would be both wrong and extremely annoying.

// True when the browser should be left alone to handle the click itself.
// `button === 1` is the middle button. Modern browsers dispatch `auxclick`
// rather than `click` for it, so this rarely fires — but it costs nothing and
// covers browsers and synthetic events that still report it here.
export function isBrowserHandledClick(e) {
  return (
    e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1
  );
}

export default function AppLink({
  view,
  onNavigate,
  guard,
  children,
  ...rest
}) {
  const href = viewToPath(view);

  function handleClick(e) {
    // Let the browser do its thing: new tab, new window, download.
    if (isBrowserHandledClick(e)) return;

    e.preventDefault();
    if (guard && !guard()) return;
    if (onNavigate) onNavigate();
  }

  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
