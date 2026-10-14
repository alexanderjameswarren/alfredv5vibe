import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import InProgressSection from "./InProgressSection";

jest.mock("./ExecutionBadge", () => ({ __esModule: true, default: ({ exec }) => <div>badge {exec.id}</div> }));

const props = { intents: [], contexts: [], getIntentDisplay: () => "", onOpen: () => {} };

test("renders nothing when nothing is in progress", () => {
  const { container } = render(<InProgressSection executions={[]} {...props} />);
  expect(container).toBeEmptyDOMElement();
});

test("lists running runs before paused ones under one heading", () => {
  render(
    <InProgressSection
      executions={[{ id: "p", status: "paused" }, { id: "a", status: "active" }]}
      {...props}
    />,
  );
  expect(screen.getByText("In progress (2)")).toBeInTheDocument();
  expect(screen.getAllByText(/^badge/).map((n) => n.textContent)).toEqual(["badge a", "badge p"]);
});
