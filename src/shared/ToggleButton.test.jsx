import React from "react";
import { render, screen } from "@testing-library/react";
import { Check } from "lucide-react";
import ToggleButton from "./ToggleButton";

const classOf = (props) => {
  const { unmount } = render(<ToggleButton icon={Check} label="T" onClick={() => {}} {...props} />);
  const cls = screen.getByRole(props.role || "button", { name: "T" }).className;
  unmount();
  return cls;
};

test("primary: brown outline and text when off, dark brown fill with white text when on", () => {
  expect(classOf({ tone: "primary", on: false })).toMatch(/border-primary bg-card text-primary/);
  expect(classOf({ tone: "primary", on: true })).toMatch(/border-primary bg-primary text-white/);
});

test("secondary: neutral outline and dark text when off, light tan fill with dark text when on", () => {
  expect(classOf({ tone: "secondary", on: false })).toMatch(/border-primary\/40 bg-card text-foreground/);
  expect(classOf({ tone: "secondary", on: true })).toMatch(/border-primary\/40 bg-secondary text-foreground/);
});

test("pressed by default, checked as a radio", () => {
  render(<ToggleButton icon={Check} label="A" on onClick={() => {}} />);
  expect(screen.getByRole("button", { name: "A" }).getAttribute("aria-pressed")).toBe("true");
  render(<ToggleButton icon={Check} label="B" on role="radio" onClick={() => {}} />);
  expect(screen.getByRole("radio", { name: "B" }).getAttribute("aria-checked")).toBe("true");
});
