import { useRealtime } from "./useRealtime";
import { supabase } from "../supabaseClient";

jest.mock("../supabaseClient", () => ({ supabase: { channel: jest.fn() } }));
jest.mock("../utils/storage", () => ({ storage: { toCamelCase: (o) => o } }));

// Each channel records its postgres_changes filter and handler.
function fakeChannels() {
  const subs = {};
  supabase.channel.mockImplementation((name) => {
    const ch = {
      on: (_kind, filter, handler) => {
        subs[name] = { filter, handler };
        return ch;
      },
      subscribe: () => ch,
      unsubscribe: jest.fn(),
    };
    return ch;
  });
  return subs;
}

const noop = () => {};
const setters = {
  setRealtimeStatus: noop, setAllInboxItems: noop, setContexts: noop, setItems: noop,
  setIntents: noop, setEvents: noop, setActiveExecutions: noop, setPausedExecutions: noop,
};

test("groups: one channel per table; insert once, upsert on update, drop on delete", async () => {
  const subs = fakeChannels();
  let rows = [{ id: "g1", name: "old" }];
  const setItemGroups = (next) => (rows = next(rows));
  const { setupRealtimeSubscriptions } = useRealtime({
    ...setters, setGroupTypes: noop, setItemGroups, setGroupMembers: noop,
  });
  const cleanup = await setupRealtimeSubscriptions({ id: "u1" });
  expect(subs["group-types-changes"].filter).toMatchObject({ table: "group_types" });
  expect(subs["item-group-members-changes"].filter).toMatchObject({ table: "item_group_members" });
  const fire = (eventType, record) => subs["item-groups-changes"].handler({ eventType, new: record, old: record });
  fire("INSERT", { id: "g1", name: "dup" });
  fire("UPDATE", { id: "g2", name: "new" });
  fire("UPDATE", { id: "g1", name: "renamed" });
  expect(rows).toEqual([{ id: "g2", name: "new" }, { id: "g1", name: "renamed" }]);
  fire("DELETE", { id: "g2" });
  expect(rows).toEqual([{ id: "g1", name: "renamed" }]);
  cleanup();
});

test("reminders: one user-filtered channel, and every change calls onReminderChange", async () => {
  const subs = fakeChannels();
  const onReminderChange = jest.fn();
  const { setupRealtimeSubscriptions } = useRealtime({ ...setters, onReminderChange });
  const cleanup = await setupRealtimeSubscriptions({ id: "u1" });
  expect(subs["reminders-changes"].filter).toMatchObject({ table: "reminders", filter: "user_id=eq.u1" });
  for (const eventType of ["INSERT", "UPDATE", "DELETE"]) subs["reminders-changes"].handler({ eventType });
  expect(onReminderChange).toHaveBeenCalledTimes(3);
  expect(typeof cleanup).toBe("function");
});
