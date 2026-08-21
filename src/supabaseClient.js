import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = 'https://zuqjyfqnvhddnchhpbcz.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo'; // Paste your anon public key here

// Step 4b of docs/technical-spec-navigation-urls.md.
//
// The default flow is `implicit`, which returns tokens in the URL fragment and
// then clears them with `window.location.hash = ''`. That assignment does two
// unwanted things: it leaves a bare `/#` in the address bar, and it creates a
// history entry. While Alfred had no router the entry was unreachable, so it
// did not matter. Step 4 made browser Back real, and a reachable entry holding
// `#access_token=...` is not something to leave lying around.
//
// PKCE returns a `?code=` query parameter instead and clears it with
// `history.replaceState` — no new entry, no leftover fragment, and the access
// token never appears in the URL at all.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { flowType: 'pkce' },
});