import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContextDetailView from "./ContextDetailView";

jest.mock("../apps/useApps", () => ({
  __esModule: true,
  default: () => [{ id: "arnold", name: "Arnold", icon: "Dumbbell" }],
}));

const SORT = { sortKey: "name", sortDir: "asc" };

function renderDetail(context) {
  return render(
    <ContextDetailView
      contextId={context.id}
      context={context}
      items={[]}
      intents={[]}
      contexts={[context]}
      getIntentDisplay={(i) => i.text}
      sort={SORT}
    />,
  );
}

describe("ContextDetailView app line", () => {
  it("shows the linked app", () => {
    renderDetail({ id: "c1", name: "Body", appId: "arnold" });
    expect(screen.getByText("Arnold")).toBeInTheDocument();
    expect(screen.getByText("App:")).toBeInTheDocument();
  });

  it("shows nothing without an app", () => {
    renderDetail({ id: "c1", name: "Body", appId: null });
    expect(screen.queryByText("App:")).toBeNull();
  });
});
