import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContextForm, { contextFormValues } from "./ContextForm";

const APPS = [
  { id: "arnold", name: "Arnold", icon: "Dumbbell" },
  { id: "warren_buffet", name: "Warren Buffet", icon: "Wallet" },
];
jest.mock("../apps/useApps", () => ({ __esModule: true, default: () => APPS }));

const CONTEXT = {
  id: "c1",
  name: "Alex (body, mind, spirit)",
  shared: false,
  keywords: null,
  description: null,
  pinned: false,
  defaultCollectionId: null,
  appId: "arnold",
};

function renderForm(editing, extra = {}) {
  const onSave = jest.fn();
  const onDirtyChange = jest.fn();
  render(<ContextForm editing={editing} onSave={onSave} onCancel={() => {}} onDirtyChange={onDirtyChange} {...extra} />);
  return { onSave, onDirtyChange };
}

const lastDirty = (fn) => fn.mock.calls[fn.mock.calls.length - 1][0];

describe("contextFormValues", () => {
  it("normalises nulls", () => {
    expect(contextFormValues(CONTEXT)).toMatchObject({ keywords: "", description: "", appId: "arnold" });
    expect(contextFormValues({ ...CONTEXT, appId: null }).appId).toBe("");
    expect(contextFormValues(null).appId).toBe("");
  });
});

describe("ContextForm app picker", () => {
  it("shows the saved app", () => {
    renderForm(CONTEXT);
    expect(screen.getByLabelText("App")).toHaveValue("arnold");
  });

  it("offers No app and every app", () => {
    renderForm(null);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["No app", "Arnold", "Warren Buffet"]));
  });

  it("is not dirty on open", () => {
    const { onDirtyChange } = renderForm(CONTEXT);
    expect(lastDirty(onDirtyChange)).toBe(false);
  });

  it("is not dirty on open with no app", () => {
    const { onDirtyChange } = renderForm({ ...CONTEXT, appId: null });
    expect(lastDirty(onDirtyChange)).toBe(false);
  });

  it("is dirty after changing the app", () => {
    const { onDirtyChange } = renderForm(CONTEXT);
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "warren_buffet" } });
    expect(lastDirty(onDirtyChange)).toBe(true);
  });

  it("saves the app as the last argument", () => {
    const { onSave } = renderForm({ ...CONTEXT, appId: null });
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "arnold" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave.mock.calls[0][6]).toBe("arnold");
  });

  it("saves No app as empty", () => {
    const { onSave } = renderForm(CONTEXT);
    fireEvent.change(screen.getByLabelText("App"), { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSave.mock.calls[0][6]).toBe("");
  });
});

describe("Archive Context", () => {
  it("asks first, then archives", () => {
    const onArchive = jest.fn();
    renderForm(CONTEXT, { onArchive });
    fireEvent.click(screen.getByRole("button", { name: "Archive Context" }));
    expect(screen.getByText("Archive this context?")).toBeInTheDocument();
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("Cancel archives nothing", () => {
    const onArchive = jest.fn();
    renderForm(CONTEXT, { onArchive });
    fireEvent.click(screen.getByRole("button", { name: "Archive Context" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Archive this context?")).toBeNull();
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("is disabled, with the reason, while the context holds anything", () => {
    renderForm(CONTEXT, { onArchive: jest.fn(), archiveBlockers: ["2 items"] });
    expect(screen.getByRole("button", { name: "Archive Context" })).toBeDisabled();
    expect(screen.getByText("Cannot archive: still holds 2 items.")).toBeInTheDocument();
  });

  it("is not on the new-context form", () => {
    renderForm(null, { onArchive: jest.fn() });
    expect(screen.queryByRole("button", { name: "Archive Context" })).toBeNull();
  });
});
