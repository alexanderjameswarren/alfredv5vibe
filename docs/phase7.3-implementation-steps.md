# Phase 7.3 Implementation Steps: Email Capture (Postmark)

**Reference**: phase7.3-progress.md for status tracking
**Reference**: Alfred_Phase7_Implementation_Plan_v3.md for full architecture context

---

## Step 3: Create email-capture Edge Function

### What to do:

**HUMAN runs**: `supabase functions new email-capture`

**CLAUDE CLI creates the files below. DO NOT search the web.**

### File 1: `supabase/functions/email-capture/deno.json`

```json
{
  "imports": {}
}
```

No external dependencies needed — just Supabase client from shared lib.

### File 2: `supabase/functions/email-capture/index.ts`

```typescript
// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";

// --- User Mapping ---
// Maps the To address pattern to a user email for lookup in auth.users
// When email arrives at alex.warren+elise+alfred@secorus.com → Elise
// When email arrives at alex.warren+alfred@secorus.com → Alex
interface UserMapping {
  pattern: RegExp;
  userEmail: string;
  label: string;
}

const USER_MAPPINGS: UserMapping[] = [
  // Order matters — more specific patterns first
  {
    pattern: /alex\.warren\+elise\+alfred@secorus\.com/i,
    label: "Elise",
    userEmail: "enhdesigns@gmail.com", 
  },
  {
    pattern: /alex\.warren\+alfred@secorus\.com/i,
    label: "Alex",
    userEmail: "alexanderjameswarren@gmail.com",
  },
];

// --- Helper: Resolve user_id from To address ---
async function resolveUserId(
  toAddress: string,
  serviceClient: ReturnType<typeof createServiceClient>
): Promise<{ userId: string; label: string } | null> {
  for (const mapping of USER_MAPPINGS) {
    if (mapping.pattern.test(toAddress)) {
      // Look up user by email in auth.users
      const { data: { users }, error } = await serviceClient.auth.admin.listUsers();
      if (error) {
        console.error("[email-capture] Error listing users:", error.message);
        return null;
      }

      const user = users.find(
        (u) => u.email?.toLowerCase() === mapping.userEmail.toLowerCase()
      );

      if (user) {
        return { userId: user.id, label: mapping.label };
      } else {
        console.error(`[email-capture] No auth user found for email: ${mapping.userEmail}`);
        return null;
      }
    }
  }

  console.error(`[email-capture] No mapping found for To address: ${toAddress}`);
  return null;
}

// --- Helper: Clean up forwarded email text ---
function cleanEmailText(subject: string, textBody: string): string {
  let text = textBody || "";

  // Remove common forwarding headers
  text = text.replace(/^-+\s*Forwarded message\s*-+\s*/im, "");
  text = text.replace(/^From:.*$/im, "");
  text = text.replace(/^Date:.*$/im, "");
  text = text.replace(/^Subject:.*$/im, "");
  text = text.replace(/^To:.*$/im, "");
  text = text.replace(/^Cc:.*$/im, "");

  // Remove Gmail forwarding artifacts
  text = text.replace(/^>+\s*/gm, ""); // quoted lines
  text = text.replace(/\n{3,}/g, "\n\n"); // collapse multiple newlines

  text = text.trim();

  // Combine subject + body if both are meaningful
  const cleanSubject = subject
    ?.replace(/^(Fwd?|Fw):\s*/i, "") // strip Fwd: prefix
    ?.replace(/^(Re):\s*/i, "")       // strip Re: prefix
    ?.trim();

  if (cleanSubject && text) {
    return `${cleanSubject}\n\n${text}`;
  } else if (cleanSubject) {
    return cleanSubject;
  } else {
    return text || "(empty email)";
  }
}

// --- Postmark Webhook JSON shape (relevant fields) ---
interface PostmarkInboundPayload {
  From: string;
  FromName: string;
  FromFull: { Email: string; Name: string };
  To: string;
  ToFull: Array<{ Email: string; Name: string; MailboxHash: string }>;
  Cc: string;
  Subject: string;
  TextBody: string;
  HtmlBody: string;
  Date: string;
  MessageID: string;
  OriginalRecipient: string;
  Tag: string;
  StrippedTextReply: string;
}

// --- Main Handler ---

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Parse Postmark webhook payload
  let payload: PostmarkInboundPayload;
  try {
    payload = await req.json();
  } catch (e) {
    console.error("[email-capture] Failed to parse JSON:", e);
    return new Response("Invalid JSON", { status: 400 });
  }

  // Log for debugging
  console.log(`[email-capture] Received email from: ${payload.From}, subject: ${payload.Subject}`);

  // Extract the To address for user mapping
  // Check OriginalRecipient first (most reliable for forwarded emails)
  // Then fall back to ToFull, then To
  const toAddress =
    payload.OriginalRecipient ||
    payload.ToFull?.[0]?.Email ||
    payload.To ||
    "";

  console.log(`[email-capture] To address for mapping: ${toAddress}`);

  // Create service client (no user session available for webhooks)
  const serviceClient = createServiceClient();

  // Resolve user
  const userResult = await resolveUserId(toAddress, serviceClient);
  if (!userResult) {
    console.error(`[email-capture] Could not resolve user for: ${toAddress}`);
    // Return 200 so Postmark doesn't retry — this is a config issue, not transient
    return new Response(JSON.stringify({
      success: false,
      error: `Could not map email recipient to a user: ${toAddress}`,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[email-capture] Mapped to user: ${userResult.label} (${userResult.userId})`);

  // Build captured_text from subject + body
  const capturedText = cleanEmailText(payload.Subject, payload.TextBody);

  // Build source_metadata
  const sourceMetadata = {
    from: payload.From,
    fromName: payload.FromName,
    subject: payload.Subject,
    messageId: payload.MessageID,
    date: payload.Date,
    originalRecipient: toAddress,
    to: payload.To,
  };

  // Insert inbox record
  const inboxRecord = {
    id: crypto.randomUUID(),
    created_at: Date.now(),
    archived: false,
    triaged_at: null,
    captured_text: capturedText,
    user_id: userResult.userId,
    source_type: "email",
    source_metadata: sourceMetadata,
    ai_status: "not_started",
    // All suggested_* fields left as defaults (null/false/[])
    suggest_item: false,
    suggest_intent: false,
    suggest_event: false,
    suggested_tags: [],
  };

  const { data, error } = await serviceClient
    .from("inbox")
    .insert(inboxRecord)
    .select()
    .single();

  if (error) {
    console.error("[email-capture] Failed to insert inbox record:", error.message);
    // Return 500 so Postmark retries
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[email-capture] Inbox record created: ${data.id} for ${userResult.label}`);

  // Return 200 — ai-enrich will be triggered manually via the UI Enrich button
  return new Response(JSON.stringify({
    success: true,
    inbox_id: data.id,
    user: userResult.label,
    captured_text_preview: capturedText.substring(0, 100),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

### IMPORTANT — Claude CLI must do this:

After creating the file, remind the user:

**You need to set the actual email addresses in the USER_MAPPINGS array.** Find these two TODO lines and replace with real values:

```typescript
userEmail: "", // TODO: Set Elise's Google OAuth email here
userEmail: "", // TODO: Set Alex's Google OAuth email here
```

Set these to the Google OAuth email addresses you and your wife use to log into Alfred (the emails in Supabase auth.users).

### Verification:
- [ ] `supabase/functions/email-capture/index.ts` exists
- [ ] `supabase/functions/email-capture/deno.json` exists
- [ ] USER_MAPPINGS has correct regex patterns for both addresses
- [ ] TypeScript compiles without errors

---

## Step 4: Deploy email-capture Function

### What to do (HUMAN — terminal commands):

```bash
# Deploy the email-capture Edge Function
# --no-verify-jwt because Postmark webhooks have no Supabase JWT
supabase functions deploy --no-verify-jwt email-capture
```

### Verification:
- [ ] Deployment succeeds without errors
- [ ] Function visible in Supabase Dashboard → Edge Functions

---

## Step 5: Test with Postmark Check Button

### What to do (HUMAN — in Postmark):

1. Go to your Postmark Server → Inbound → Settings
2. Your webhook URL should be: `https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/email-capture`
3. Click the **Check** button
4. Postmark will send a test payload to your webhook

### Expected result:
- Postmark shows a green check / success
- The Edge Function receives the test POST
- It will likely fail to map the user (test payload has fake addresses) — that's fine, we're just verifying connectivity
- Check Supabase Dashboard → Edge Functions → email-capture → Logs to see the output

### Troubleshooting:
- If Postmark shows failure: check the function is deployed, check the URL is correct
- If you see CORS errors: shouldn't happen (Postmark is server-to-server, no browser involved)
- If you see "Could not map email recipient": expected for test payload — the real test is Step 6

### Verification:
- [ ] Postmark Check button shows success (200 response)
- [ ] Edge Function logs show the incoming request

---

## Step 6: Test End-to-End

### What to do (HUMAN):

**Test 1 — Your email (Alex):**
1. Find any email in your Gmail inbox
2. Click Forward
3. Set the To address to: `alex.warren+alfred@secorus.com`
4. Send

Wait 30-60 seconds, then check:
- Supabase Table Editor → `inbox` table
- Look for a new record with `source_type = 'email'`
- Verify `user_id` matches your auth user ID
- Verify `captured_text` contains the subject + body (cleaned up)
- Verify `source_metadata` has from, subject, messageId
- Verify `ai_status = 'not_started'`

**Test 2 — Elise's email:**
1. Have Elise forward an email to: `alex.warren+elise+alfred@secorus.com`
2. Check inbox table — should have a record with Elise's user_id

**Test 3 — Verify in Alfred UI:**
1. Open Alfred in the browser
2. Go to the Inbox view
3. The forwarded email should appear as an inbox item
4. It should show the 📧 email source indicator
5. ai_status should show "Not Started"
6. Click "Enrich" — Sonnet should enrich it with suggestions

### Troubleshooting:
- **No record appears**: Check Edge Function logs in Supabase Dashboard. Check Postmark Inbound → Activity to see if the email was received.
- **User mapping fails**: Check the To address in the logs. Verify the regex patterns match. Verify the userEmail values match what's in auth.users.
- **Secorus forwarding not working**: Send a test email directly to your Postmark inbound address to verify Postmark is receiving emails. Then debug the forwarding.
- **Captured text is messy**: The cleanEmailText function may need tuning for your specific email formats. We can iterate.

### Verification:
- [ ] Test 1: Alex's forwarded email appears in inbox with correct user_id
- [ ] Test 2: Elise's forwarded email appears with her user_id
- [ ] Test 3: Emails visible in Alfred UI inbox
- [ ] source_type = 'email' on all records
- [ ] ai_status = 'not_started' (ready for manual enrichment)

---

## Completion

When all steps are verified:
1. Update phase7.3-progress.md — mark all steps as ✅ Complete
2. Update the overall status to ✅ Complete
3. Proceed to Phase 7.4 (Alfred UI Updates) or Phase 8+
