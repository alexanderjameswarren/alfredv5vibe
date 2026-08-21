import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import AppLink from "./AppLink";
import { VIEW_TO_PATH } from "./viewPaths";

// The whole point of AppLink is what it does NOT do on a modified click.
// That is invisible in the UI until someone loses a form, so it is pinned
// here instead.

// Dispatch a click and report whether AppLink cancelled it, without letting
// jsdom attempt a real navigation (which it cannot do, and would log noise
// about). The listener runs in the bubble phase, i.e. after AppLink's own
// handler, so it observes the final state before suppressing the default.
function clickAndReport(el, init) {
  let prevented = null;
  function observe(e) {
    prevented = e.defaultPrevented;
    e.preventDefault();
  }
  document.addEventListener("click", observe);
  try {
    fireEvent.click(el, init);
  } finally {
    document.removeEventListener("click", observe);
  }
  return prevented;
}

const MODIFIERS = [
  ["Ctrl-click", { ctrlKey: true }],
  ["Cmd-click", { metaKey: true }],
  ["Shift-click", { shiftKey: true }],
  ["Alt-click", { altKey: true }],
  ["middle click", { button: 1 }],
];

describe("renders a real link", () => {
  it("is an anchor carrying the mapped path", () => {
    render(<AppLink view="inbox">Inbox</AppLink>);
    const link = screen.getByRole("link", { name: "Inbox" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/inbox");
  });

  it("produces a real href for all 18 views", () => {
    for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
      const { unmount } = render(<AppLink view={view}>{view}</AppLink>);
      expect(screen.getByRole("link", { name: view })).toHaveAttribute(
        "href",
        path
      );
      unmount();
    }
  });

  it("falls back to home rather than rendering a broken href", () => {
    render(<AppLink view="nonsense">X</AppLink>);
    expect(screen.getByRole("link", { name: "X" })).toHaveAttribute("href", "/");
  });

  it("passes presentation props through untouched", () => {
    render(
      <AppLink view="home" className="tab active" title="Go home">
        Home
      </AppLink>
    );
    const link = screen.getByRole("link", { name: "Home" });
    expect(link).toHaveClass("tab", "active");
    expect(link).toHaveAttribute("title", "Go home");
  });
});

describe("plain left click navigates in place", () => {
  it("cancels the default and calls onNavigate", () => {
    const onNavigate = jest.fn();
    render(<AppLink view="inbox" onNavigate={onNavigate}>Inbox</AppLink>);

    const prevented = clickAndReport(screen.getByRole("link"));

    expect(prevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("runs the guard before navigating", () => {
    const calls = [];
    render(
      <AppLink
        view="inbox"
        guard={() => (calls.push("guard"), true)}
        onNavigate={() => calls.push("navigate")}
      >
        Inbox
      </AppLink>
    );

    fireEvent.click(screen.getByRole("link"));
    expect(calls).toEqual(["guard", "navigate"]);
  });

  it("does not navigate when the guard refuses", () => {
    const onNavigate = jest.fn();
    render(
      <AppLink view="inbox" guard={() => false} onNavigate={onNavigate}>
        Inbox
      </AppLink>
    );

    const prevented = clickAndReport(screen.getByRole("link"));

    // Still cancelled — a refused guard must leave you exactly where you are,
    // not fall through to the browser and navigate anyway.
    expect(prevented).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("works with no guard supplied", () => {
    const onNavigate = jest.fn();
    render(<AppLink view="inbox" onNavigate={onNavigate}>Inbox</AppLink>);
    fireEvent.click(screen.getByRole("link"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("modified clicks are left entirely to the browser", () => {
  it.each(MODIFIERS)("%s does not cancel the default", (_label, init) => {
    render(<AppLink view="inbox" onNavigate={jest.fn()}>Inbox</AppLink>);
    expect(clickAndReport(screen.getByRole("link"), init)).toBe(false);
  });

  it.each(MODIFIERS)("%s does not call onNavigate", (_label, init) => {
    const onNavigate = jest.fn();
    render(<AppLink view="inbox" onNavigate={onNavigate}>Inbox</AppLink>);
    clickAndReport(screen.getByRole("link"), init);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each(MODIFIERS)("%s does not run the guard", (_label, init) => {
    // The current tab is not navigating, so the dirty form is not at risk.
    // Prompting here would be wrong as well as maddening.
    const guard = jest.fn(() => true);
    render(
      <AppLink view="inbox" guard={guard} onNavigate={jest.fn()}>
        Inbox
      </AppLink>
    );
    clickAndReport(screen.getByRole("link"), init);
    expect(guard).not.toHaveBeenCalled();
  });
});

describe("keyboard activation behaves like a plain click", () => {
  it("Enter on a focused link navigates in place", () => {
    // Browsers translate Enter on an anchor into a click with no modifiers,
    // so this must take the in-place branch, not the new-tab one.
    const onNavigate = jest.fn();
    render(<AppLink view="inbox" onNavigate={onNavigate}>Inbox</AppLink>);
    const link = screen.getByRole("link");
    link.focus();
    expect(link).toHaveFocus();
    expect(clickAndReport(link)).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
