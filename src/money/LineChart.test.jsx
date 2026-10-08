import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import LineChart, { chartGeometry } from "./LineChart";

// Invented data only.
describe("LineChart", () => {
  it("says so when there is not enough history", () => {
    render(<LineChart label="Net worth" data={[{ day: "2026-01-01", value: 5 }]} />);
    expect(screen.getByText(/not enough history/i)).toBeInTheDocument();
  });

  it("draws a labelled line from the first to the last point", () => {
    render(<LineChart label="Net worth" data={[
      { day: "2026-01-01", value: 100 }, { day: "2026-01-02", value: "150.5" }, { day: "2026-01-03", value: 120 },
    ]} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label", "Net worth: $100.00 on Jan 1, 2026 to $120.00 on Jan 3, 2026",
    );
    expect(screen.getByText(/low \$100\.00 · high \$150\.50/)).toBeInTheDocument();
  });

  it("adds a zero line only when the values cross zero", () => {
    expect(chartGeometry([{ y: -5 }, { y: 5 }], 180).zeroY).not.toBeNull();
    expect(chartGeometry([{ y: 1 }, { y: 5 }], 180).zeroY).toBeNull();
    expect(chartGeometry([{ y: 3 }, { y: 3 }], 180).path).toMatch(/^M/);
  });
});
