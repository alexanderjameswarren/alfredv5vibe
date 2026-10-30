// ============================================================================
// supabase/functions/_shared/tools/alfred-push.ts
//
// send_alfred_push — tier 1, shared by every app. Sends one Alfred Web Push to
// every device the caller has subscribed, and logs it in claude_notifications
// in the same call. Spec: docs/arnold_v1-technical-spec.md §5.
//
// Order matters: the VAPID check first (so a configuration fault never burns a
// dedupe key), then the log row (a repeated dedupe_key is refused before
// anything is sent, and a crash after this point can never double-send), then
// the send, then the delivery result on the same row.
//
// push_subscriptions.endpoint, p256dh and auth_key are secret columns: they are
// read here through ctx.db (RLS: the caller's own rows) only to send, and never
// returned. Results name devices by subscription id.
// ============================================================================

import { defineTool } from "../platform.ts";
import { loadVapid, sendToAll } from "../web-push-send.ts";
import type { EndpointResult, PushSubscriptionRow } from "../web-push-send.ts";
import { dbError, fail, KINDS, logNotification, optionalText, requireEnum, requireText } from "./claude-notifications.ts";

type Row = Record<string, unknown>;

/** An Alfred path such as /inbox/abc. The service worker resolves it against its own origin. */
export function requireAlfredPath(tool: string, v: unknown): string | null {
  const link = optionalText(tool, "link", v);
  if (link === null) return null;
  if (!link.startsWith("/") || link.startsWith("//") || /\s/.test(link)) {
    throw fail(tool, `\`link\` must be an Alfred path starting with "/", e.g. "/inbox/<id>", got ${JSON.stringify(link)}.`);
  }
  return link;
}

/** The delivery status and detail recorded for a set of endpoint results. */
export function deliveryOutcome(results: EndpointResult[]) {
  const sent = results.some((r) => r.ok);
  return {
    status: results.length === 0 ? "no_subscription" : sent ? "sent" : "failed",
    detail: {
      devices: results.length,
      sent_to: results.filter((r) => r.ok).length,
      dead_subscription_ids: results.filter((r) => r.dead).map((r) => r.subscription_id),
      endpoints: results,
      sent_at: new Date().toISOString(),
    },
  };
}

export const sendAlfredPushTool = defineTool({
  name: "send_alfred_push",
  tables: { reads: ["apps", "claude_notifications", "push_subscriptions"], writes: ["claude_notifications"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "send_alfred_push";
    const app = requireText(tool, "app", args.app, 100);
    const job = requireText(tool, "job", args.job, 100);
    const kind = requireEnum(tool, "kind", args.kind, KINDS);
    const title = requireText(tool, "title", args.title, 200);
    const body = optionalText(tool, "body", args.body);
    const link = requireAlfredPath(tool, args.link);
    const dedupeKey = requireText(tool, "dedupe_key", args.dedupe_key, 300);

    try {
      loadVapid();
    } catch (e) {
      throw fail(tool, `push is not configured: ${(e as Error).message}. Nothing was logged or sent.`);
    }

    const logged = await logNotification(ctx.db, tool, {
      app, job, kind, channel: "alfred_push", title, dedupe_key: dedupeKey, body, link,
    });
    if (!logged.created) {
      throw fail(tool, `refused: dedupe_key "${dedupeKey}" has already been used ` +
        `(${JSON.stringify(logged.duplicate_of ?? {})}). Nothing was sent. This key will always be refused; ` +
        `that notification has already gone out.`);
    }

    const record = async (status: string, detail: Row) => {
      const { error } = await ctx.db.from("claude_notifications")
        .update({ delivery_status: status, delivery_detail: detail }).eq("id", logged.id);
      return error ? `The push result could not be recorded on the log row: ${error.message}` : null;
    };

    const { data: subs, error: subsError } = await ctx.db.from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_key");
    if (subsError) {
      await record("failed", { error: `Could not read push subscriptions: ${subsError.message}` });
      throw dbError(tool, "push_subscriptions read", subsError);
    }

    const payload = JSON.stringify({
      title,
      body: body ?? "",
      // One tag per notification: a repeat would replace, not stack, but the dedupe key stops repeats anyway.
      tag: `claude-${app}-${dedupeKey}`,
      url: link ?? "/",
    });
    const results = await sendToAll((subs ?? []) as PushSubscriptionRow[], payload);
    const outcome = deliveryOutcome(results);
    const recordError = await record(outcome.status, outcome.detail);

    return {
      notification_id: logged.id,
      delivery_status: outcome.status,
      devices: outcome.detail.devices,
      sent_to: outcome.detail.sent_to,
      dead_subscription_ids: outcome.detail.dead_subscription_ids,
      endpoints: results,
      ...(recordError ? { warning: recordError } : {}),
    };
  },
});
