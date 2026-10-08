import React from "react";
import { render, screen } from "@testing-library/react";
import ExecutionBadge from "./ExecutionBadge";

function card(status) {
  const { container, unmount } = render(
    <ExecutionBadge
      exec={{ id: "x", intentId: "i1", status }}
      intents={[{ id: "i1", text: "Water plants" }]}
      contexts={[]}
      getIntentDisplay={(i) => i.text}
      onOpen={() => {}}
    />,
  );
  const cls = container.firstChild.className;
  unmount();
  return cls;
}

test("an active run is teal, not brown", () => {
  const cls = card("active");
  expect(cls).toMatch(/border-success/);
  expect(cls).toMatch(/bg-success-light/);
  expect(cls).not.toMatch(/primary/);
});

test("a paused run stays amber", () => {
  expect(card("paused")).toMatch(/border-warning/);
  render(
    <ExecutionBadge exec={{ id: "x", status: "paused" }} intents={[]} contexts={[]} getIntentDisplay={() => ""} onOpen={() => {}} />,
  );
  expect(screen.getByText(/Paused/)).toBeTruthy();
});
