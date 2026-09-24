import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// The clips row and the signed URLs both come through the BROWSER client, which
// carries the signed-in user's own token — so the `clipboard` bucket's
// folder-per-user read policy is what decides. Spec 4.2: reads never use the
// service role. What is mocked here is that client, nothing else.
const mockMaybeSingle = jest.fn();
const mockCreateSignedUrls = jest.fn();

jest.mock("./supabaseClient", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: (...a) => mockMaybeSingle(...a) }),
      }),
    }),
    storage: {
      from: () => ({ createSignedUrls: (...a) => mockCreateSignedUrls(...a) }),
    },
  },
}));

const ClipboardCapture = require("./ClipboardCapture").default;

const CLIP = {
  id: "clip-1",
  title: "80,000 Hours job board",
  url: "https://jobs.80000hours.org/",
  source: "clipboard",
  page_text: "First line.\nSecond line.",
  text_truncated: false,
  links: [{ text: "A role", href: "https://jobs.80000hours.org/a" }],
  links_truncated: false,
  slice_paths: ["user-1/clip-1/slice-01.jpg", "user-1/clip-1/slice-02.jpg"],
  slice_count: 2,
  screenshot_truncated: false,
  page_width: 1280,
  page_height: 6047,
};

const item = (meta = {}) => ({ id: "inbox-1", sourceMetadata: { clipId: "clip-1", ...meta } });

function setup(props = {}) {
  return render(<ClipboardCapture clipId="clip-1" inboxItem={item()} {...props} />);
}

beforeEach(() => {
  mockMaybeSingle.mockReset();
  mockCreateSignedUrls.mockReset();
  mockMaybeSingle.mockResolvedValue({ data: CLIP, error: null });
  mockCreateSignedUrls.mockResolvedValue({
    data: [{ signedUrl: "https://signed/1" }, { signedUrl: "https://signed/2" }],
    error: null,
  });
});

describe("while it is loading", () => {
  it("says so, rather than showing an empty section", () => {
    mockMaybeSingle.mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByRole("status")).toHaveTextContent(/Loading what was captured/);
  });
});

describe("the page text", () => {
  it("shows it", async () => {
    setup();
    expect(await screen.findByText(/First line\./)).toBeInTheDocument();
  });

  it("offers Show all for long text, and toggles back", async () => {
    mockMaybeSingle.mockResolvedValue({
      data: { ...CLIP, page_text: "line\n".repeat(30) },
      error: null,
    });
    setup();
    const showAll = await screen.findByRole("button", { name: /Show all/ });
    fireEvent.click(showAll);
    expect(screen.getByRole("button", { name: /Show less/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show less/ }));
    expect(screen.getByRole("button", { name: /Show all/ })).toBeInTheDocument();
  });

  it("does not offer Show all for text that fits", async () => {
    setup();
    await screen.findByText(/First line\./);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("says when the text was cut at 1 MB during capture", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ...CLIP, text_truncated: true }, error: null });
    setup();
    expect(await screen.findByText(/longer than 1 MB/)).toBeInTheDocument();
  });
});

describe("the links", () => {
  it("are behind a count, not spread down the page", async () => {
    setup();
    const toggle = await screen.findByRole("button", { name: /Links/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "A role" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole("link", { name: "A role" })).toBeInTheDocument();
  });

  it("open in a new tab, since the page they came from is elsewhere", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Links/ }));
    const link = screen.getByRole("link", { name: "A role" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("href", "https://jobs.80000hours.org/a");
  });

  it("say when the 1,000-link cap was hit", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ...CLIP, links_truncated: true }, error: null });
    setup();
    expect(await screen.findByText(/more than 1,000 links/)).toBeInTheDocument();
  });

  it("are absent entirely for a capture with none", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ...CLIP, links: [] }, error: null });
    setup();
    await screen.findByText(/First line\./);
    expect(screen.queryByRole("button", { name: /Links/ })).not.toBeInTheDocument();
  });
});

describe("the screenshot", () => {
  it("signs every slice in one call, through the user's own session", async () => {
    setup();
    await waitFor(() => expect(mockCreateSignedUrls).toHaveBeenCalled());
    expect(mockCreateSignedUrls).toHaveBeenCalledTimes(1);
    expect(mockCreateSignedUrls.mock.calls[0][0]).toEqual(CLIP.slice_paths);
  });

  it("shows the slices in page order, top to bottom", async () => {
    setup();
    const images = await screen.findAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("src", "https://signed/1");
    expect(images[1]).toHaveAttribute("src", "https://signed/2");
    expect(images[0]).toHaveAttribute("alt", "Screenshot slice 1 of 2");
  });

  it("shows a loading state per slice until the image arrives", async () => {
    setup();
    await screen.findAllByRole("img");
    expect(screen.getByText("Loading 1 of 2…")).toBeInTheDocument();
    fireEvent.load(screen.getAllByRole("img")[0]);
    expect(screen.queryByText("Loading 1 of 2…")).not.toBeInTheDocument();
    // The second is independent and still loading.
    expect(screen.getByText("Loading 2 of 2…")).toBeInTheDocument();
  });

  it("explains a slice that cannot load, and keeps the others", async () => {
    // Per-slice, because the failure is per-slice: one object can be missing from a
    // set of nine, and a single banner would either hide eight good images or claim
    // all nine were fine.
    setup();
    const images = await screen.findAllByRole("img");
    fireEvent.error(images[0]);
    expect(screen.getByText(/Slice 1 of 2 could not be loaded/)).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("degrades to no pictures, not no capture, when signing fails", async () => {
    mockCreateSignedUrls.mockResolvedValue({ data: null, error: { message: "nope" } });
    setup();
    expect(await screen.findByText(/screenshot could not be loaded/)).toBeInTheDocument();
    // The text is already in hand and must survive.
    expect(screen.getByText(/First line\./)).toBeInTheDocument();
  });

  it("keeps a slice's POSITION when only that one could not be signed", async () => {
    // Numbering has to keep matching the page, so a hole is a hole rather than a
    // shift.
    mockCreateSignedUrls.mockResolvedValue({
      data: [{ signedUrl: null }, { signedUrl: "https://signed/2" }],
      error: null,
    });
    setup();
    expect(await screen.findByText(/Slice 1 of 2 could not be prepared/)).toBeInTheDocument();
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("alt", "Screenshot slice 2 of 2");
  });

  it("shows no screenshot section for a capture that has none", async () => {
    // A CLI report never has one.
    mockMaybeSingle.mockResolvedValue({ data: { ...CLIP, slice_paths: [], slice_count: 0 }, error: null });
    setup();
    await screen.findByText(/First line\./);
    expect(mockCreateSignedUrls).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("the screenshot caveat", () => {
  it("warns when the screenshot is incomplete, with the recorded reason", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { ...CLIP, screenshot_truncated: true }, error: null });
    render(
      <ClipboardCapture
        clipId="clip-1"
        inboxItem={item({ screenshotNote: "The page scrolls inside a container." })}
      />,
    );
    expect(await screen.findByText(/does not show the whole page/)).toBeInTheDocument();
    expect(screen.getByText(/scrolls inside a container/)).toBeInTheDocument();
  });

  it("says a visible-screen capture is the screen only, though nothing is broken", async () => {
    render(<ClipboardCapture clipId="clip-1" inboxItem={item({ captureMode: "visible" })} />);
    expect(await screen.findByText(/visible screen only/)).toBeInTheDocument();
  });

  it("says nothing for a complete full-page screenshot", async () => {
    setup();
    await screen.findAllByRole("img");
    expect(screen.queryByText(/whole page/)).not.toBeInTheDocument();
    expect(screen.queryByText(/visible screen/)).not.toBeInTheDocument();
  });
});

describe("when the clip is not there", () => {
  it("says the stored page is gone, and that the capture is still fine", async () => {
    // A missing row and one hidden by RLS both arrive as null, and both mean the
    // same thing here. Not an error: the capture is still perfectly triageable.
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    setup();
    expect(await screen.findByText(/no longer stored/)).toBeInTheDocument();
    expect(screen.getByText(/still triage it/)).toBeInTheDocument();
  });

  it("reports a real query failure without blocking triage", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "network down" } });
    setup();
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
    expect(screen.getByText(/still triage it/)).toBeInTheDocument();
  });
});
