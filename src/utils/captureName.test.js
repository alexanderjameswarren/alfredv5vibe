import fs from "fs";
import path from "path";
import { splitCaptureName, CAPTURE_NAME_MAX } from "./captureName";

describe("splitCaptureName", () => {
  test("multi-line: first line is the name", () => {
    expect(splitCaptureName("Fix the gutter\nLeft side, above the porch.\nNeeds a ladder")).toEqual({
      name: "Fix the gutter",
      rest: "Left side, above the porch.\nNeeds a ladder",
    });
  });

  test("long single line: first sentence, trailing period dropped", () => {
    const text =
      "Try the duck mole tacos from the Sunday paper. They need two days of prep and a trip to the Mexican grocery for chiles.";
    expect(splitCaptureName(text)).toEqual({
      name: "Try the duck mole tacos from the Sunday paper",
      rest: "They need two days of prep and a trip to the Mexican grocery for chiles.",
    });
  });

  test("question mark is kept", () => {
    const text = "Should we repaint the hallway before the holidays? " + "x ".repeat(40);
    expect(splitCaptureName(text).name).toBe("Should we repaint the hallway before the holidays?");
  });

  test("short capture is not split", () => {
    expect(splitCaptureName("Call the plumber. Number is 555-0100.")).toEqual({
      name: "Call the plumber. Number is 555-0100.",
      rest: "",
    });
  });

  test("no sentence break near 80: word boundary", () => {
    const text =
      "remember to look into whether the community garden plot renewal needs the form or can be done online and when the deadline is";
    const { name, rest } = splitCaptureName(text);
    expect(name.length).toBeLessThanOrEqual(CAPTURE_NAME_MAX);
    expect(text.startsWith(name)).toBe(true);
    expect(`${name} ${rest}`).toBe(text);
    expect(name.endsWith(" ")).toBe(false);
  });

  test("sentence break beyond 80 falls back to word boundary", () => {
    const text = "a ".repeat(50) + "end. More.";
    const { name } = splitCaptureName(text);
    expect(name.length).toBeLessThanOrEqual(CAPTURE_NAME_MAX);
  });

  test("one unbroken word is hard-cut", () => {
    const { name, rest } = splitCaptureName("x".repeat(100));
    expect(name).toHaveLength(CAPTURE_NAME_MAX);
    expect(rest).toHaveLength(20);
  });

  test("decimals are not sentence breaks", () => {
    const text = "Use 2.5 cups of stock instead of water " + "y ".repeat(40);
    expect(splitCaptureName(text).name.startsWith("Use 2.5 cups")).toBe(true);
  });

  test("empty and null", () => {
    expect(splitCaptureName("")).toEqual({ name: "", rest: "" });
    expect(splitCaptureName(null)).toEqual({ name: "", rest: "" });
  });
});

test("Deno twin body is identical", () => {
  const body = (file) => {
    const src = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const m = src.match(/\/\/ --- twin body start ---\n([\s\S]*?)\/\/ --- twin body end ---/);
    return m && m[1];
  };
  const js = body(path.join(__dirname, "captureName.js"));
  const ts = body(path.join(__dirname, "..", "..", "supabase", "functions", "_shared", "captureName.ts"));
  expect(js).toBeTruthy();
  expect(ts).toBe(js);
});
