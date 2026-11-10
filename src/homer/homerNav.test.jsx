import React from "react";
import { render } from "@testing-library/react";
import { NAV_ITEMS } from "../shared/AppChrome";
import ObjectIcon from "../shared/ObjectIcon";
import { viewToPath } from "../viewPaths";

test("Homer is in the nav right after Overwatch, with a book icon, at /homer", () => {
  const keys = NAV_ITEMS.map((i) => i.key);
  expect(keys[keys.indexOf("overwatch") + 1]).toBe("homer");
  expect(NAV_ITEMS.find((i) => i.key === "homer")).toEqual({ key: "homer", label: "Homer", icon: "homer" });
  expect(viewToPath("homer")).toBe("/homer");
  const { container } = render(<ObjectIcon type="homer" />);
  expect(container.querySelector("svg")).not.toBeNull();
});
