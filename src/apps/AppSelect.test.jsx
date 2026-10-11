import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import AppSelect from "./AppSelect";
import AppIcon from "./AppIcon";

jest.mock("../supabaseClient", () => ({ supabase: {} }));

const APPS = [{ id: "arnold", name: "Arnold", icon: "Dumbbell" }];

describe("AppSelect", () => {
  it("shows the chosen app's icon", () => {
    const { container } = render(<AppSelect apps={APPS} value="arnold" onChange={() => {}} />);
    expect(container.querySelector("svg.lucide-dumbbell")).toBeInTheDocument();
  });

  it("shows no icon for No app", () => {
    const { container } = render(<AppSelect apps={APPS} value="" onChange={() => {}} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByLabelText("App")).toHaveValue("");
  });

  it("keeps a saved app before the list loads", () => {
    render(<AppSelect apps={[]} value="arnold" onChange={() => {}} />);
    expect(screen.getByLabelText("App")).toHaveValue("arnold");
  });
});

describe("AppIcon", () => {
  it("falls back for an unknown name", () => {
    const { container } = render(<AppIcon icon="Nope" />);
    expect(container.querySelector("svg.lucide-layout-grid")).toBeInTheDocument();
  });
});
