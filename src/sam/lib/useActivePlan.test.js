import { renderHook, act, waitFor } from "@testing-library/react";
import useActivePlan from "./useActivePlan";

const mockLoadPlan = jest.fn();
const mockLoadProgress = jest.fn();
jest.mock("../../supabaseClient", () => ({ supabase: {} }));
jest.mock("./activePlan", () => ({
  ...jest.requireActual("./activePlan"),
  loadActivePlan: (...a) => mockLoadPlan(...a),
  loadTodayProgress: (...a) => mockLoadProgress(...a),
}));

const plan = (id) => ({ id, songs: [], items: [{ id: `${id}-item`, song_id: "s1", snippet_id: null }] });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  mockLoadPlan.mockReset();
  mockLoadProgress.mockReset();
  mockLoadProgress.mockResolvedValue(new Map());
});

test("a song opening reloads plan and progress", async () => {
  mockLoadPlan.mockResolvedValue(plan("p1"));
  const { result, rerender } = renderHook(({ k }) => useActivePlan(k), { initialProps: { k: null } });
  await waitFor(() => expect(result.current.plan?.id).toBe("p1"));
  expect(mockLoadPlan).toHaveBeenCalledTimes(1);

  mockLoadPlan.mockResolvedValue(plan("p2"));
  rerender({ k: "song-1|" });
  await waitFor(() => expect(result.current.plan?.id).toBe("p2"));
  expect(mockLoadProgress).toHaveBeenLastCalledWith(expect.anything(), "p2", expect.any(String));
  expect(result.current.getLink("s1", null)).toEqual({ plan_id: "p2", plan_item_id: "p2-item" });
});

test("a snippet change on the same song reloads", async () => {
  mockLoadPlan.mockResolvedValue(plan("p1"));
  const { result, rerender } = renderHook(({ k }) => useActivePlan(k), { initialProps: { k: "song-1|" } });
  await waitFor(() => expect(result.current.plan?.id).toBe("p1"));
  mockLoadPlan.mockResolvedValue(plan("p2"));
  rerender({ k: "song-1|snip-1" });
  await waitFor(() => expect(result.current.plan?.id).toBe("p2"));
  expect(mockLoadPlan).toHaveBeenCalledTimes(2);
});

test("the same key does not reload", async () => {
  mockLoadPlan.mockResolvedValue(plan("p1"));
  const { result, rerender } = renderHook(({ k }) => useActivePlan(k), { initialProps: { k: "song-1|" } });
  await waitFor(() => expect(result.current.loaded).toBe(true));
  rerender({ k: "song-1|" });
  expect(mockLoadPlan).toHaveBeenCalledTimes(1);
});

test("refresh after a pass reloads the plan, not only progress", async () => {
  mockLoadPlan.mockResolvedValue(plan("p1"));
  const { result } = renderHook(() => useActivePlan("song-1|"));
  await waitFor(() => expect(result.current.plan?.id).toBe("p1"));
  mockLoadPlan.mockResolvedValue(plan("p2"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.plan?.id).toBe("p2");
});

test("a slow older load never overwrites a newer one", async () => {
  const slow = deferred();
  mockLoadPlan.mockReturnValueOnce(slow.promise).mockResolvedValue(plan("new"));
  const { result } = renderHook(() => useActivePlan(null));
  // Asked again while the first load is in flight: one more load is queued.
  act(() => { result.current.refresh(); });
  await act(async () => { slow.resolve(plan("old")); });
  await waitFor(() => expect(result.current.plan?.id).toBe("new"));
  expect(mockLoadPlan).toHaveBeenCalledTimes(2);
  expect(result.current.getLink("s1", null).plan_id).toBe("new");
});

test("a slow older progress response never overwrites a newer one", async () => {
  mockLoadPlan.mockResolvedValue(plan("p1"));
  const { result } = renderHook(() => useActivePlan(null));
  await waitFor(() => expect(result.current.plan?.id).toBe("p1"));
  const slow = deferred();
  mockLoadProgress.mockReturnValueOnce(slow.promise)
    .mockResolvedValueOnce(new Map([["p1-item", { attempts: 2 }]]));
  act(() => { result.current.refreshProgress(); });
  await act(async () => { await result.current.refreshProgress(); });
  await act(async () => { slow.resolve(new Map()); });
  expect(result.current.progress.get("p1-item")).toEqual({ attempts: 2 });
});
