import { copyRecord, recordCopyText } from "./copyRecord";

describe("recordCopyText", () => {
  it("title, description, then the link on its own line", () => {
    expect(recordCopyText({ title: "Water plants", description: "Front and back", id: "abc" })).toBe(
      "Water plants\n\nFront and back\n\nhttps://alfredv5vibe.vercel.app/abc",
    );
  });

  it("leaves out the description block when there is none", () => {
    expect(recordCopyText({ title: "Water plants", description: "  ", id: "abc" })).toBe(
      "Water plants\n\nhttps://alfredv5vibe.vercel.app/abc",
    );
    expect(recordCopyText({ title: "Water plants", id: "abc" })).toBe(
      "Water plants\n\nhttps://alfredv5vibe.vercel.app/abc",
    );
  });
});

describe("copyRecord", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("writes the text and says Copied", async () => {
    const writeText = jest.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    const notify = jest.fn();
    await copyRecord({ title: "T", id: "x" }, notify);
    expect(writeText).toHaveBeenCalledWith("T\n\nhttps://alfredv5vibe.vercel.app/x");
    expect(notify).toHaveBeenCalledWith("Copied");
  });

  it("reports a failed write as an error", async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error("denied")) } });
    const notify = jest.fn();
    expect(await copyRecord({ title: "T", id: "x" }, notify)).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Could not copy/), { error: true });
  });
});
