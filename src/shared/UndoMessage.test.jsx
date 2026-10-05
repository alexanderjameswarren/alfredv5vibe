import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import UndoMessage, { useUndo, UNDO_DURATION_MS } from "./UndoMessage";

// Undo replaces confirmation dialogs, so these behaviours are the only thing
// between a destructive click and permanent loss. They are cheap to break by
// accident (a stray timer, a second click) and invisible when they are, which
// is why they are pinned here rather than left to manual checking.

// A minimal host that wires the hook to the component the way Alfred does.
function Harness({ duration, onRestore }) {
  const { pendingUndo, offerUndo, runUndo, dismissUndo } = useUndo(duration);
  return (
    <div>
      <button onClick={() => offerUndo("Item archived.", onRestore)}>
        offer A
      </button>
      <button onClick={() => offerUndo("Intention archived.", onRestore)}>
        offer B
      </button>
      <UndoMessage
        pendingUndo={pendingUndo}
        onUndo={runUndo}
        onDismiss={dismissUndo}
      />
    </div>
  );
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function advance(ms) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe("the message", () => {
  it("renders nothing until something is offered", () => {
    render(<UndoMessage pendingUndo={null} onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByText("Undo")).not.toBeInTheDocument();
  });

  it("shows the caller's message and an Undo action", () => {
    render(<Harness onRestore={jest.fn()} />);
    fireEvent.click(screen.getByText("offer A"));

    expect(screen.getByText("Item archived.")).toBeInTheDocument();
    expect(screen.getByText("Undo")).toBeInTheDocument();
  });
});

describe("expiry", () => {
  it("stays up for the full duration", () => {
    render(<Harness onRestore={jest.fn()} />);
    fireEvent.click(screen.getByText("offer A"));

    advance(UNDO_DURATION_MS - 1);
    expect(screen.getByText("Item archived.")).toBeInTheDocument();
  });

  it("disappears once the duration elapses", () => {
    render(<Harness onRestore={jest.fn()} />);
    fireEvent.click(screen.getByText("offer A"));

    advance(UNDO_DURATION_MS);
    expect(screen.queryByText("Item archived.")).not.toBeInTheDocument();
  });

  it("does not restore anything on its own when it expires", () => {
    const restore = jest.fn();
    render(<Harness onRestore={restore} />);
    fireEvent.click(screen.getByText("offer A"));

    advance(UNDO_DURATION_MS);
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("undoing", () => {
  it("runs the caller's restore", () => {
    const restore = jest.fn();
    render(<Harness onRestore={restore} />);
    fireEvent.click(screen.getByText("offer A"));
    fireEvent.click(screen.getByText("Undo"));

    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("takes the message down, so a second click cannot restore twice", () => {
    const restore = jest.fn();
    render(<Harness onRestore={restore} />);
    fireEvent.click(screen.getByText("offer A"));
    fireEvent.click(screen.getByText("Undo"));

    expect(screen.queryByText("Item archived.")).not.toBeInTheDocument();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("cancels the expiry timer, so nothing fires afterwards", () => {
    const restore = jest.fn();
    render(<Harness onRestore={restore} />);
    fireEvent.click(screen.getByText("offer A"));
    fireEvent.click(screen.getByText("Undo"));

    advance(UNDO_DURATION_MS * 2);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe("dismissing", () => {
  it("takes the message down without restoring", () => {
    const restore = jest.fn();
    render(<Harness onRestore={restore} />);
    fireEvent.click(screen.getByText("offer A"));
    fireEvent.click(screen.getByLabelText("Dismiss"));

    expect(screen.queryByText("Item archived.")).not.toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("the single slot", () => {
  it("replaces the message when a second undo is offered", () => {
    render(<Harness onRestore={jest.fn()} />);
    fireEvent.click(screen.getByText("offer A"));
    fireEvent.click(screen.getByText("offer B"));

    expect(screen.queryByText("Item archived.")).not.toBeInTheDocument();
    expect(screen.getByText("Intention archived.")).toBeInTheDocument();
  });

  // The regression this guards: if offering did not clear the previous timer,
  // the first offer's timer would still be live and would expire the SECOND
  // offer early — cutting a fresh 5 seconds short by however long the first
  // one had already been on screen.
  it("gives the replacement its own full duration", () => {
    render(<Harness onRestore={jest.fn()} />);
    fireEvent.click(screen.getByText("offer A"));

    advance(UNDO_DURATION_MS - 500);
    fireEvent.click(screen.getByText("offer B"));

    advance(600);
    expect(screen.getByText("Intention archived.")).toBeInTheDocument();

    advance(UNDO_DURATION_MS);
    expect(screen.queryByText("Intention archived.")).not.toBeInTheDocument();
  });

  it("runs only the surviving offer's restore", () => {
    const first = jest.fn();
    const second = jest.fn();
    function TwoRestores() {
      const { pendingUndo, offerUndo, runUndo, dismissUndo } = useUndo();
      return (
        <div>
          <button onClick={() => offerUndo("first", first)}>offer first</button>
          <button onClick={() => offerUndo("second", second)}>offer second</button>
          <UndoMessage
            pendingUndo={pendingUndo}
            onUndo={runUndo}
            onDismiss={dismissUndo}
          />
        </div>
      );
    }
    render(<TwoRestores />);
    fireEvent.click(screen.getByText("offer first"));
    fireEvent.click(screen.getByText("offer second"));
    fireEvent.click(screen.getByText("Undo"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("restore shapes", () => {
  // The spec names two; the app needs a third. All three are just closures, so
  // this pins the contract rather than any particular implementation: whatever
  // the caller passes is what runs, and an async restore is awaited.
  it("supports an async restore that touches several records", async () => {
    const writes = [];
    const restore = jest.fn(async () => {
      writes.push("intent");
      writes.push("event");
      writes.push("deleted the recurrence successor");
    });

    render(<Harness onRestore={restore} />);
    fireEvent.click(screen.getByText("offer A"));
    await act(async () => {
      fireEvent.click(screen.getByText("Undo"));
    });

    expect(writes).toEqual([
      "intent",
      "event",
      "deleted the recurrence successor",
    ]);
  });
});
