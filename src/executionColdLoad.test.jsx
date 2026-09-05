import React, { useState, useEffect } from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useExecutionRoute } from "./useExecutionRoute";
import {
  executionIdFromPath,
  isKnownPath,
  parentPath,
  pathToView,
  DEFAULT_PATH,
} from "./viewPaths";

// Cold-loading an execution URL — the notification-chain Phase 1 headline path.
//
// Alfred.jsx cannot be rendered in a test: 11,000 lines, a Supabase client at
// module scope, and the whole app behind it. So the harness below supplies the
// surroundings — a router, an auth handshake, the redirect guard — but the
// logic under test is the REAL `useExecutionRoute`, imported, not copied.
//
// That distinction is the point of the file. The first version of this test
// reproduced the guard's shape instead of importing it, which is a test that
// can stay green while the shipping code drifts away from it — the same
// twin-site failure that once stripped `collectable` from elements.

// The id from the original manual failure report.
const EXEC_ID = "mtmzlltzfhsy6drjio";
const EXEC_PATH = `/schedule/execution/${EXEC_ID}`;

/**
 * Everything Alfred wraps around the hook: the router bridge, the auth
 * handshake, the DETAIL_VIEW_STATE guard, and the two render branches.
 */
function ExecutionRouteHarness({ fetchExecution, onNavigate, seedExecution = null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname;
  const view = pathToView(location.pathname);

  // Auth starts unresolved, exactly as in Alfred: this is the transition the
  // original bug hid in.
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeExecution, setActiveExecution] = useState(seedExecution);

  const { awaitingExecutionLoad, executionForRoute } = useExecutionRoute({
    pathname: location.pathname,
    user,
    activeExecution,
    setActiveExecution,
    fetchExecution,
  });

  const DETAIL_VIEW_STATE = { "execution-detail": executionForRoute };
  const detailStateMissing =
    view in DETAIL_VIEW_STATE &&
    !DETAIL_VIEW_STATE[view] &&
    !awaitingExecutionLoad;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setUser({ id: "user-1" });
      setAuthLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isKnownPath(currentPath)) {
      navigate(DEFAULT_PATH, { replace: true });
      onNavigate(DEFAULT_PATH);
      return;
    }
    if (detailStateMissing) {
      navigate(parentPath(currentPath), { replace: true });
      onNavigate(parentPath(currentPath));
    }
  }, [currentPath, detailStateMissing, navigate, onNavigate]);

  // Alfred returns early while auth is unresolved, so the main tree — and the
  // placeholder inside it — does not render at all yet.
  if (authLoading) return <p>Loading...</p>;
  if (!user) return <p>LoginScreen</p>;

  return (
    <div>
      <p data-testid="path">{location.pathname}</p>
      {view === "execution-detail" && !executionForRoute && awaitingExecutionLoad && (
        <p>Opening execution…</p>
      )}
      {view === "execution-detail" && executionForRoute && (
        <p data-testid="execution">{executionForRoute.id}</p>
      )}
      <p data-testid="active-execution">
        {activeExecution ? activeExecution.id : "none"}
      </p>
    </div>
  );
}

function renderColdLoad({
  row = { id: EXEC_ID },
  delayMs = 0,
  seedExecution = null,
  path = EXEC_PATH,
} = {}) {
  const navigations = [];
  const fetchExecution = jest.fn(
    () =>
      new Promise((resolve) => {
        if (delayMs === 0) resolve(row);
        else setTimeout(() => resolve(row), delayMs);
      })
  );
  render(
    <MemoryRouter initialEntries={[path]}>
      <ExecutionRouteHarness
        fetchExecution={fetchExecution}
        seedExecution={seedExecution}
        onNavigate={(p) => navigations.push(p)}
      />
    </MemoryRouter>
  );
  return { navigations, fetchExecution };
}

// Let pending microtasks and their resulting effects flush.
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("cold-loading an execution URL", () => {
  it("resolves the id from the pasted path", () => {
    // Sanity: the routing half. Pinned so a regression here is
    // distinguishable from a timing regression below.
    expect(executionIdFromPath(EXEC_PATH)).toBe(EXEC_ID);
    expect(pathToView(EXEC_PATH)).toBe("execution-detail");
    expect(isKnownPath(EXEC_PATH)).toBe(true);
  });

  it("does not redirect to /schedule while the execution is being fetched", async () => {
    // The original bug: the guard fired in the one render between auth
    // resolving and the fetch starting.
    const { navigations } = renderColdLoad();
    await settle();
    expect(navigations).toEqual([]);
  });

  it("opens the execution rather than the schedule list", async () => {
    const { navigations } = renderColdLoad();
    await settle();
    expect(navigations).not.toContain("/schedule");
    expect(await screen.findByTestId("execution")).toHaveTextContent(EXEC_ID);
  });

  it("fetches the execution named by the URL", async () => {
    const { fetchExecution } = renderColdLoad();
    await settle();
    expect(fetchExecution).toHaveBeenCalledWith(EXEC_ID);
  });

  it("shows the placeholder while the fetch is outstanding", async () => {
    renderColdLoad({ delayMs: 50 });
    await settle();
    expect(screen.getByText("Opening execution…")).toBeInTheDocument();
  });

  it("fetches once, not on every render", async () => {
    // The hook holds the caller's inline fetch function in a ref. Without
    // that, a new function identity each render re-triggers the effect
    // forever.
    const { fetchExecution } = renderColdLoad();
    await settle();
    await settle();
    expect(fetchExecution).toHaveBeenCalledTimes(1);
  });
});

describe("when the execution cannot be loaded", () => {
  it("redirects to /schedule", async () => {
    // The other half of the contract: a fix that simply never redirects would
    // pass everything above.
    const { navigations } = renderColdLoad({ row: null });
    await settle();
    expect(navigations).toContain("/schedule");
  });

  it("does not retry the failed lookup in a loop", async () => {
    const { fetchExecution } = renderColdLoad({ row: null });
    await settle();
    await settle();
    expect(fetchExecution).toHaveBeenCalledTimes(1);
  });

  it("clears an execution the URL no longer names", async () => {
    // The stale-state case: arriving at a bad deep link while a previous
    // execution is still in memory. Without clearing, the guard sees "an
    // execution is present", declines to redirect, and Alfred draws the old
    // execution under the new URL.
    const { navigations } = renderColdLoad({
      row: null,
      seedExecution: { id: "previous-execution" },
    });
    await settle();
    expect(screen.queryByTestId("execution")).not.toBeInTheDocument();
    expect(navigations).toContain("/schedule");
  });

  it("never renders a stale execution under a different execution's URL", async () => {
    renderColdLoad({ delayMs: 50, seedExecution: { id: "previous-execution" } });
    await settle();
    // The URL names EXEC_ID; the only execution in state is a different one.
    expect(screen.queryByText("previous-execution")).not.toBeInTheDocument();
    expect(screen.getByText("Opening execution…")).toBeInTheDocument();
  });
});

describe("the id-less execution path still behaves as before", () => {
  it("redirects to /schedule when nothing is in state", async () => {
    const { navigations } = renderColdLoad({ path: "/schedule/execution" });
    await settle();
    expect(navigations).toContain("/schedule");
  });

  it("does not fetch, having no id to fetch", async () => {
    const { fetchExecution } = renderColdLoad({ path: "/schedule/execution" });
    await settle();
    expect(fetchExecution).not.toHaveBeenCalled();
  });

  it("renders whatever is in state, as it always did", async () => {
    // In-app navigation that does not carry an id relies on this.
    renderColdLoad({
      path: "/schedule/execution",
      seedExecution: { id: "in-memory-execution" },
    });
    await settle();
    expect(screen.getByTestId("execution")).toHaveTextContent("in-memory-execution");
  });
});
