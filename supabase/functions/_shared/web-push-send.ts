// Web Push sending for MCP tools (send_alfred_push). Copied from notify-dispatch's
// VAPID check and send loop, which stays untouched; a change to how Alfred sends a
// push belongs in both until notify-dispatch is moved onto this module.
//
// Two differences from notify-dispatch, both on purpose:
//   - this module never touches the database. A dead endpoint (404/410) is
//     reported as `dead`, not deleted; notify-dispatch removes those itself.
//   - results carry the subscription id, never any part of the endpoint, since
//     they are returned to the model and the endpoint is a secret column.

import webpush from "npm:web-push@3.6.7";
import { createECDH } from "node:crypto";
import { Buffer } from "node:buffer";
import { PUSH_SEND_OPTIONS } from "./push-options.ts";

/** Permanently gone, not failing. Any other status is transient. Same rule as notify-dispatch. */
export const DEAD_STATUS = new Set([404, 410]);

/** The secrets notify-dispatch and push-send use; project-wide, so every function has them. */
export const VAPID_SECRET_NAMES = ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"];

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

export interface EndpointResult {
  subscription_id: string;
  status: number | null;
  ok: boolean;
  dead: boolean;
  error?: string;
  service_body?: string;
}

interface WebPushLike {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: Record<string, unknown>,
  ): Promise<{ statusCode?: number } | undefined>;
}

/**
 * Load and check the VAPID configuration; returns the public key it signs with.
 * The public half is derivable from the private half, so a mismatched pair is
 * caught here as one clear error rather than as a 403 from the push service.
 */
export function loadVapid(
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
  wp: WebPushLike = webpush as unknown as WebPushLike,
): string {
  const [subject, publicKey, privateKey] = VAPID_SECRET_NAMES.map((n) => env(n));
  const missing = VAPID_SECRET_NAMES.filter((n) => !env(n));
  if (missing.length) {
    throw new Error(`Missing edge function secret(s): ${missing.join(", ")}`);
  }

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey!, "base64url"));
  if (ecdh.getPublicKey().toString("base64url") !== publicKey) {
    throw new Error(
      "VAPID keypair mismatch: VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY. " +
        "The browser subscribed against REACT_APP_VAPID_PUBLIC_KEY, so all three must be the same pair.",
    );
  }

  wp.setVapidDetails(subject!, publicKey!, privateKey!);
  return publicKey!;
}

/** One payload to every device; never throws for a single device's failure. */
export function sendToAll(
  subs: PushSubscriptionRow[],
  payload: string,
  wp: WebPushLike = webpush as unknown as WebPushLike,
): Promise<EndpointResult[]> {
  return Promise.all(
    subs.map(async (sub): Promise<EndpointResult> => {
      try {
        const res = await wp.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          payload,
          PUSH_SEND_OPTIONS,
        );
        return { subscription_id: sub.id, status: res?.statusCode ?? 201, ok: true, dead: false };
      } catch (err) {
        const e = err as { statusCode?: number; body?: string; message?: string };
        const status = typeof e.statusCode === "number" ? e.statusCode : null;
        return {
          subscription_id: sub.id,
          status,
          ok: false,
          dead: status !== null && DEAD_STATUS.has(status),
          error: e.message ?? String(err),
          ...(e.body ? { service_body: String(e.body).slice(0, 200) } : {}),
        };
      }
    }),
  );
}
