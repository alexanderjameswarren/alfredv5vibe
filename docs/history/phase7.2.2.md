Implement Supabase Realtime subscriptions with connection status indicator to solve:
1. Stale connection freezes (all operations hang after 30 seconds idle)
2. MCP changes not visible without refresh
3. Multi-device sync

Realtime is now enabled in Supabase for all tables.

PART 1: Add Connection State Management

1. Add connection state to Alfred component (around line 50 with other state):

const [realtimeStatus, setRealtimeStatus] = useState('disconnected'); // 'connected', 'connecting', 'disconnected'

2. Add connection status indicator to header (in the div with settings/trash/sign out buttons):

{/* Connection status indicator */}
<div 
  className="flex items-center gap-1"
  title={realtimeStatus === 'connected' ? 'Connected' : realtimeStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
>
  <div className={`w-2 h-2 rounded-full ${
    realtimeStatus === 'connected' ? 'bg-success' : 
    realtimeStatus === 'connecting' ? 'bg-warning animate-pulse' : 
    'bg-gray-400'
  }`} />
</div>

PART 2: Create Realtime Subscription Setup

3. Add subscription setup function (after loadData function, around line 150):

async function setupRealtimeSubscriptions() {
  if (!user) return null;
  
  console.log('[Realtime] Setting up subscriptions for user:', user.id);
  setRealtimeStatus('connecting');
  
  // Helper to convert snake_case database records to camelCase
  const toCamelCase = (obj) => {
    if (!obj) return obj;
    const camelObj = {};
    for (const key in obj) {
      const camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      camelObj[camelKey] = obj[key];
    }
    return camelObj;
  };
  
  // Subscribe to inbox changes
  const inboxChannel = supabase
    .channel('inbox-changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'inbox',
        filter: `user_id=eq.${user.id}`
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

PART 3: Create Change Handlers

4. Add change handler functions (after setupRealtimeSubscriptions):

function handleInboxChange(payload, toCamelCase) {
  const { eventType, new: newRecord, old: oldRecord } = payload;
  
  if (eventType === 'INSERT') {
    const record = toCamelCase(newRecord);
    setInboxItems(prev => {
      // Don't add duplicates
      if (prev.find(item => item.id === record.id)) return prev;
      // Add to top, maintain sort by createdAt
      return [record, ...prev].sort((a, b) => b.createdAt - a.createdAt);
    });
  } else if (eventType === 'UPDATE') {
    const record = toCamelCase(newRecord);
    setInboxItems(prev => 
      prev.map(item => item.id === record.id ? record : item)
    );
  } else if (eventType === 'DELETE') {
    setInboxItems(prev => 
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
    setExecutions(prev => {
      if (prev.find(exec => exec.id === record.id)) return prev;
      return [...prev, record];
    });
  } else if (eventType === 'UPDATE') {
    const record = toCamelCase(newRecord);
    setExecutions(prev => 
      prev.map(exec => exec.id === record.id ? record : exec)
    );
  } else if (eventType === 'DELETE') {
    setExecutions(prev => 
      prev.filter(exec => exec.id !== oldRecord.id)
    );
  }
}

PART 4: Wire Up Subscriptions in useEffect

5. Find the existing useEffect that calls checkAuth (around line 65-100).

Replace it with this updated version that sets up realtime after loading data:

useEffect(() => {
  let realtimeCleanup = null;
  
  async function initializeApp() {
    // Check auth
    const { data: { user } } = await supabase.auth.getUser();
    
    // If user exists, check allowlist
    if (user) {
      console.log('Checking allowlist for:', user.email);
      
      const { data, error } = await supabase
        .from('allowed_emails')
        .select('email')
        .eq('email', user.email)
        .maybeSingle();
      
      console.log('Allowlist result:', { data, error });
      
      if (error || !data) {
        console.log('Email not allowed, signing out');
        await supabase.auth.signOut();
        alert('Access denied. Your email is not authorized to access this app.');
        setUser(null);
        setAuthLoading(false);
        return;
      }
      
      console.log('Email allowed, proceeding');
    }
    
    setUser(user);
    setAuthLoading(false);
    
    if (user) {
      // Load initial data
      await loadData();
      
      // Set up realtime subscriptions
      realtimeCleanup = await setupRealtimeSubscriptions();
    }
  }
  
  initializeApp();
  
  // Listen for auth state changes