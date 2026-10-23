import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import MenuRecipeSections, { jumpTarget, pinnedTopHeight } from "./MenuRecipeSections";
import { currentUserId, listExecutionNotes, saveNote } from "../notes/notesApi";

jest.mock("../notes/notesApi", () => ({ currentUserId: jest.fn(), listExecutionNotes: jest.fn(), saveNote: jest.fn() }));
jest.mock("../NotificationChainInline", () => ({
  useNotificationChain: () => ({ reload: async () => {} }),
  ChainUnreachableNotice: () => null,
  ElementNotification: () => null,
  ChainRemainingToggle: () => null,
}));

beforeEach(() => {
  currentUserId.mockResolvedValue("u");
  listExecutionNotes.mockResolvedValue([]);
  saveNote.mockImplementation(async (n) => ({ id: "n1", ...n }));
});

const rice = { id: "r1", itemIds: ["rice"], status: "active", elements: [{ name: "Rinse", displayType: "step" }] };
const dal = { id: "r2", itemIds: ["dal"], status: "active", outcome: "skipped", elements: [] };
const recipes = [
  { run: rice, item: { id: "rice", name: "Instant Pot Spanish Rice" } },
  { run: dal, item: { id: "dal", name: "Butternut Squash Red Lentil Dal" } },
];

function renderSections(extra = {}) {
  const props = { recipes, closed: false, onToggleElement: jest.fn(async () => {}), onUpdateElement: jest.fn(), onSkip: jest.fn(), ...extra };
  render(<MenuRecipeSections {...props} />);
  return props;
}

test("a jump bar of recipe names, and one section per recipe with its steps", async () => {
  renderSections();
  const bar = screen.getByRole("navigation", { name: "Recipes" });
  expect(within(bar).getAllByRole("button").map((b) => b.textContent)).toEqual(["Instant Pot Spanish Rice", "Butternut Squash Red Lentil Dal"]);
  expect(bar).toHaveClass("sticky", "overflow-x-auto");
  expect(screen.getByRole("region", { name: "Instant Pot Spanish Rice" })).toHaveTextContent("Rinse");
  await screen.findAllByPlaceholderText(/^Notes on/);
});

test("ticking a step goes to that recipe's run; a section collapses and the jump bar reopens it", async () => {
  const props = renderSections();
  await screen.findAllByPlaceholderText(/^Notes on/);
  fireEvent.click(screen.getAllByTestId("element-check")[0]);
  await waitFor(() => expect(props.onToggleElement).toHaveBeenCalledWith(rice, 0));
  const rice$ = screen.getByRole("region", { name: "Instant Pot Spanish Rice" });
  fireEvent.click(within(rice$).getByRole("button", { name: /Instant Pot Spanish Rice/ }));
  expect(within(rice$).queryByText("Rinse")).toBeNull();
  fireEvent.click(within(screen.getByRole("navigation")).getByText("Instant Pot Spanish Rice"));
  expect(within(rice$).getByText("Rinse")).toBeInTheDocument();
});

test("Skip and Unskip; a skipped recipe says so", async () => {
  const props = renderSections();
  await screen.findAllByPlaceholderText(/^Notes on/);
  fireEvent.click(within(screen.getByRole("region", { name: "Instant Pot Spanish Rice" })).getByRole("button", { name: "Skip" }));
  expect(props.onSkip).toHaveBeenCalledWith(rice, true);
  const dal$ = screen.getByRole("region", { name: "Butternut Squash Red Lentil Dal" });
  expect(within(dal$).getByText("Skipped")).toBeInTheDocument();
  fireEvent.click(within(dal$).getByRole("button", { name: "Unskip" }));
  expect(props.onSkip).toHaveBeenCalledWith(dal, false);
});

test("a recipe's note saves on the recipe, with its run's execution id", async () => {
  renderSections();
  const box = await screen.findByLabelText("Note on Instant Pot Spanish Rice");
  await waitFor(() => expect(box).not.toBeDisabled());
  fireEvent.change(box, { target: { value: "Used brown rice" } });
  fireEvent.blur(box);
  await waitFor(() =>
    expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ body: "Used brown rice", targetType: "item", targetId: "rice", executionId: "r1" })),
  );
});

test("the bar sticks under whatever is pinned at the top; a jump lands the header right under the bar", () => {
  document.body.innerHTML = `<header id="app" style="position: sticky; top: 0px"></header><div id="other"></div>`;
  const app = document.getElementById("app");
  app.getBoundingClientRect = () => ({ top: 0, bottom: 64, height: 64, width: 400 });
  expect(pinnedTopHeight(document)).toBe(64);
  expect(pinnedTopHeight(document, app)).toBe(0);
  // Section 500px down the viewport, page scrolled 300, bar ends at 64 + 52.
  expect(jumpTarget({ sectionTop: 500, scrollY: 300, barBottom: 116 })).toBe(684);
  expect(jumpTarget({ sectionTop: 10, scrollY: 0, barBottom: 116 })).toBe(0);
  document.body.innerHTML = "";
});

test("closed: Done marks, no Skip", async () => {
  renderSections({ closed: true });
  await screen.findAllByPlaceholderText(/^Notes on/);
  expect(screen.queryByRole("button", { name: /^(Skip|Unskip)$/ })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Instant Pot Spanish Rice" })).getByText("Done")).toBeInTheDocument();
});
