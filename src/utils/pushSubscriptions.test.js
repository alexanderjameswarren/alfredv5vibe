import fs from "fs";
import path from "path";
import { planSubscriptionReconcile } from "./pushSubscriptions";
import { ROTATION_DB, ROTATION_STORE, ROTATION_KEY } from "./pushRotation";

const OLD = "https://fcm.googleapis.com/fcm/send/u1M86D-nbqfDJ6irg4vT";
const NEW = "https://fcm.googleapis.com/fcm/send/RTGFXHai4kAUwhEPoqsm";
const OTHER_DEVICE = "https://fcm.googleapis.com/fcm/send/someOtherPhone12345";

describe("planSubscriptionReconcile", () => {
  it("does nothing when the browser and the table already agree", () => {
    const plan = planSubscriptionReconcile(NEW, [NEW], null);
    expect(plan).toEqual({ insert: false, deleteEndpoints: [], reason: "already in sync" });
  });

  it("stores a subscription the table has never seen", () => {
    // The backstop case: a rotation happened while Alfred was closed, so there
    // is no worker record, but the endpoint on this device is not in the table.
    const plan = planSubscriptionReconcile(NEW, [OLD], null);
    expect(plan.insert).toBe(true);
    expect(plan.deleteEndpoints).toEqual([]);
  });

  it("swaps old for new when the worker recorded the rotation", () => {
    const plan = planSubscriptionReconcile(NEW, [OLD], { oldEndpoint: OLD, newEndpoint: NEW });
    expect(plan.insert).toBe(true);
    expect(plan.deleteEndpoints).toEqual([OLD]);
  });

  it("NEVER deletes another device's row", () => {
    // The dangerous mistake: "delete everything that is not the current
    // endpoint" would silently unsubscribe the user's other phone. Only the
    // endpoint the worker said this device rotated away from is removed.
    const plan = planSubscriptionReconcile(NEW, [OLD, OTHER_DEVICE], {
      oldEndpoint: OLD,
      newEndpoint: NEW,
    });
    expect(plan.deleteEndpoints).toEqual([OLD]);
    expect(plan.deleteEndpoints).not.toContain(OTHER_DEVICE);
  });

  it("leaves other devices alone with no rotation record either", () => {
    const plan = planSubscriptionReconcile(NEW, [NEW, OTHER_DEVICE], null);
    expect(plan.deleteEndpoints).toEqual([]);
    expect(plan.insert).toBe(false);
  });

  it("cleans up the old row even when the new endpoint is already stored", () => {
    // The worker's postMessage path can repair the insert first; a later
    // reconcile must still remove the row it rotated away from.
    const plan = planSubscriptionReconcile(NEW, [OLD, NEW], { oldEndpoint: OLD });
    expect(plan.insert).toBe(false);
    expect(plan.deleteEndpoints).toEqual([OLD]);
  });

  it("does nothing for a browser that never subscribed", () => {
    const plan = planSubscriptionReconcile(null, [OTHER_DEVICE], null);
    expect(plan).toEqual({
      insert: false,
      deleteEndpoints: [],
      reason: "no local subscription, nothing to reconcile",
    });
  });

  it("removes the rotated-away row even if resubscribing failed", () => {
    // The worker records the rotation whether or not it managed to resubscribe.
    // A dead row must not be left answering 201 forever.
    const plan = planSubscriptionReconcile(null, [OLD], { oldEndpoint: OLD, newEndpoint: null });
    expect(plan.deleteEndpoints).toEqual([OLD]);
    expect(plan.insert).toBe(false);
  });

  it("ignores a stale record whose old endpoint is already gone", () => {
    const plan = planSubscriptionReconcile(NEW, [NEW], { oldEndpoint: OLD });
    expect(plan.deleteEndpoints).toEqual([]);
  });

  it("does not delete the endpoint the browser is currently using", () => {
    // A malformed record naming the live endpoint must not disarm the device.
    const plan = planSubscriptionReconcile(NEW, [NEW], { oldEndpoint: NEW });
    expect(plan.deleteEndpoints).toEqual([]);
  });

  it("tolerates junk", () => {
    expect(planSubscriptionReconcile(null, null, null).insert).toBe(false);
    expect(planSubscriptionReconcile(NEW, undefined, undefined).insert).toBe(true);
  });
});

describe("the service worker and the app agree on the IDB handoff", () => {
  // A worker cannot import from src/, so the database, store and key names are
  // duplicated in public/notify-sw.js. If they drift, the worker writes a
  // rotation record the app never reads and the repair silently stops working
  // — with nothing failing anywhere. This is the twin-site guard.
  const sw = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "notify-sw.js"),
    "utf8"
  );

  it("uses the same database name", () => {
    expect(sw).toContain(`const ROTATION_DB = '${ROTATION_DB}'`);
  });

  it("uses the same object store name", () => {
    expect(sw).toContain(`const ROTATION_STORE = '${ROTATION_STORE}'`);
  });

  it("uses the same record key", () => {
    expect(sw).toContain(`const ROTATION_KEY = '${ROTATION_KEY}'`);
  });

  it("actually listens for pushsubscriptionchange", () => {
    expect(sw).toContain("addEventListener('pushsubscriptionchange'");
  });

  it("reuses the old subscription's application server key", () => {
    // Resubscribing with a different key produces a subscription the
    // dispatcher's VAPID pair cannot send to.
    expect(sw).toContain("applicationServerKey");
    expect(sw).toContain("options.applicationServerKey");
  });

  it("still has no fetch handler", () => {
    // Unchanged since Phase 0: a worker with a fetch handler would start
    // intercepting requests and could serve a stale bundle.
    expect(sw).not.toContain("addEventListener('fetch'");
  });
});
