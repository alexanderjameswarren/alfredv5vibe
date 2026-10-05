import { supabase } from "../supabaseClient";
import { storage } from "../utils/storage";

// The realtime subscriptions and their change handlers, moved out of Alfred.jsx
// unchanged. No effects: Alfred's auth effect calls `setupRealtimeSubscriptions`
// and holds the cleanup it returns, exactly as before.
export function useRealtime({
  setRealtimeStatus,
  setAllInboxItems,
  setContexts,
  setItems,
  setIntents,
  setEvents,
  setActiveExecutions,
  setPausedExecutions,
}) {
  async function setupRealtimeSubscriptions(currentUser) {
    if (!currentUser) return null;

    console.log('[Realtime] Setting up subscriptions for user:', currentUser.id);
    setRealtimeStatus('connecting');

    // Use the recursive converter so JSONB columns (elements, tags, etc.) get camelCased too
    const toCamelCase = (obj) => storage.toCamelCase(obj);

    // Subscribe to inbox changes
    const inboxChannel = supabase
      .channel('inbox-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inbox',
          filter: `user_id=eq.${currentUser.id}`
        },
        (payload) => {
          console.log('[Realtime] Inbox change:', payload.eventType, payload);
          handleInboxChange(payload, toCamelCase);
        }
      )
      .subscribe((status) => {
        console.log('[Realtime] Inbox subscription status:', status);
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected');
        }
      });

    // Subscribe to contexts changes
    const contextsChannel = supabase
      .channel('contexts-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'contexts'
        },
        (payload) => {
          console.log('[Realtime] Context change:', payload.eventType);
          handleContextChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to items changes
    const itemsChannel = supabase
      .channel('items-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items'
        },
        (payload) => {
          console.log('[Realtime] Item change:', payload.eventType);
          handleItemChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to intents changes
    const intentsChannel = supabase
      .channel('intents-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'intents'
        },
        (payload) => {
          console.log('[Realtime] Intent change:', payload.eventType);
          handleIntentChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to events changes
    const eventsChannel = supabase
      .channel('events-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'events'
        },
        (payload) => {
          console.log('[Realtime] Event change:', payload.eventType);
          handleEventChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to executions changes
    const executionsChannel = supabase
      .channel('executions-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'executions'
        },
        (payload) => {
          console.log('[Realtime] Execution change:', payload.eventType);
          handleExecutionChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Return cleanup function
    return () => {
      console.log('[Realtime] Unsubscribing all channels');
      setRealtimeStatus('disconnected');
      inboxChannel.unsubscribe();
      contextsChannel.unsubscribe();
      itemsChannel.unsubscribe();
      intentsChannel.unsubscribe();
      eventsChannel.unsubscribe();
      executionsChannel.unsubscribe();
    };
  }

  /**
   * Keep `allInboxItems` in step with the table, live.
   *
   * ── This handler got SMALLER in Step 22, and that is the news ────────────────
   *
   * It used to know about `archived`: it dropped archived rows on INSERT, removed them
   * from the list on UPDATE, and put un-archived ones back — because the list it
   * maintained was the LIVE inbox and the loaders filtered the same way. Three copies of
   * one rule, in two loaders and here, which had to be changed together or the screen
   * disagreed with itself depending on when you last refreshed.
   *
   * Now the state is the whole table and `inboxItems` is derived from it, so this handler
   * mirrors the table and holds no opinion at all: a row arrives, a row changes, a row
   * goes. An archive is an ordinary UPDATE and both views follow from it — which is also
   * how the archived section became live for free.
   *
   * The one thing it still owns is the ORDER, `createdAt` ascending, matching both
   * loaders. Do not "add to top": the live inbox is a queue worked from the front, and
   * the sort is what enforces that rather than array order. ("Recently archived" sorts
   * itself, the other way round, in `recentlyArchived`.)
   */
  function handleInboxChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    const upsertSorted = (prev, record) =>
      [...prev.filter(item => item.id !== record.id), record]
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setAllInboxItems(prev => (
        prev.find(item => item.id === record.id) ? prev : upsertSorted(prev, record)
      ));
    } else if (eventType === 'UPDATE') {
      // Upsert rather than map: a row can arrive here without ever having been in `prev`
      // (another device captured and enriched it between refreshes), and a plain `map`
      // would silently do nothing.
      setAllInboxItems(prev => upsertSorted(prev, toCamelCase(newRecord)));
    } else if (eventType === 'DELETE') {
      setAllInboxItems(prev =>
        prev.filter(item => item.id !== oldRecord.id)
      );
    }
  }

  function handleContextChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setContexts(prev => {
        if (prev.find(ctx => ctx.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setContexts(prev =>
        prev.map(ctx => ctx.id === record.id ? record : ctx)
      );
    } else if (eventType === 'DELETE') {
      setContexts(prev =>
        prev.filter(ctx => ctx.id !== oldRecord.id)
      );
    }
  }

  function handleItemChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setItems(prev => {
        if (prev.find(item => item.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setItems(prev =>
        prev.map(item => item.id === record.id ? record : item)
      );
    } else if (eventType === 'DELETE') {
      setItems(prev =>
        prev.filter(item => item.id !== oldRecord.id)
      );
    }
  }

  function handleIntentChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setIntents(prev => {
        if (prev.find(intent => intent.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setIntents(prev =>
        prev.map(intent => intent.id === record.id ? record : intent)
      );
    } else if (eventType === 'DELETE') {
      setIntents(prev =>
        prev.filter(intent => intent.id !== oldRecord.id)
      );
    }
  }

  function handleEventChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setEvents(prev => {
        if (prev.find(event => event.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setEvents(prev =>
        prev.map(event => event.id === record.id ? record : event)
      );
    } else if (eventType === 'DELETE') {
      setEvents(prev =>
        prev.filter(event => event.id !== oldRecord.id)
      );
    }
  }

  function handleExecutionChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      if (record.status === 'active') {
        setActiveExecutions(prev => {
          if (prev.find(exec => exec.id === record.id)) return prev;
          return [...prev, record];
        });
      } else if (record.status === 'paused') {
        setPausedExecutions(prev => {
          if (prev.find(exec => exec.id === record.id)) return prev;
          return [...prev, record];
        });
      }
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      // Remove from both lists first
      setActiveExecutions(prev => prev.filter(exec => exec.id !== record.id));
      setPausedExecutions(prev => prev.filter(exec => exec.id !== record.id));
      // Add to appropriate list based on status
      if (record.status === 'active') {
        setActiveExecutions(prev => [...prev, record]);
      } else if (record.status === 'paused') {
        setPausedExecutions(prev => [...prev, record]);
      }
    } else if (eventType === 'DELETE') {
      setActiveExecutions(prev => prev.filter(exec => exec.id !== oldRecord.id));
      setPausedExecutions(prev => prev.filter(exec => exec.id !== oldRecord.id));
    }
  }

  return { setupRealtimeSubscriptions };
}
