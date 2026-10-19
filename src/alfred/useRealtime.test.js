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
