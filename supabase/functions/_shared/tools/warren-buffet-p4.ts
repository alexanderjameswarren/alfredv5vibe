// ============================================================================
// supabase/functions/_shared/tools/warren-buffet-p4.ts
//
// Warren Buffet Phase 4 tools. Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D10;
// the review tool: docs/technical-spec-warren_buffet_p4-r6d-money_chat.md.
//
//   set_wb_order_item_tags         tier 2 — an item's Category tag: by ids, by ASIN, or every untagged item of one site
//   split_wb_order_charges         tier 2 — split matched Amazon charges by their items' categories; safe to rerun
//   record_wb_subscription_review  tier 2 — save a review and move the subscription's review date, together
//
// No real amounts in this file.
// ============================================================================

import { defineTool, describeDbError } from "../platform.ts";
import { absent, oneOf, optText, parseDate, parseMoney } from "./warren-buffet.ts";
import { dbError, HAND_SOURCES, idList, optInt, REVIEW_COLUMNS, uuidOf } from "./warren-buffet-p2.ts";
import { ORDER_SITES } from "./warren-buffet-p3.ts";

type Obj = Record<string, unknown>;

export const MAX_ORDER_ITEM_IDS = 100;
export const MAX_ORDER_CHARGE_IDS = 50;
export const REVIEW_VERDICTS = ["keep", "downgrade", "switch", "shop_around", "cancel"] as const;

export const setWbOrderItemTagsTool = defineTool({
  name: "set_wb_order_item_tags",
  tables: { reads: ["wb_tags", "wb_tag_groups"], writes: ["wb_order_items"] },
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "set_wb_order_item_tags";
    const tagId = uuidOf(T, "tag_id", args.tag_id);
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";
    const itemIds = absent(args.item_ids) ? null : idList(T, "item_ids", args.item_ids, MAX_ORDER_ITEM_IDS);
    const asin = optText(T, "asin", args.asin);
    const site = oneOf(T, "untagged_site", args.untagged_site, ORDER_SITES);
    if ([itemIds, asin, site].filter((x) => x !== null).length !== 1) {
      throw new Error(`${T}: pass exactly one of item_ids, asin or untagged_site. Nothing was changed.`);
    }
    const { data, error } = await ctx.db.rpc("wb_set_order_item_tags", {
      p_tag_id: tagId, p_item_ids: itemIds, p_asin: asin, p_site: site, p_source: source,
    });
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});

export const splitWbOrderChargesTool = defineTool({
  name: "split_wb_order_charges",
  tables: {
    reads: ["wb_order_matches", "wb_orders", "wb_order_items", "wb_transactions", "wb_splits", "wb_split_tags", "wb_tags", "wb_tag_groups", "wb_planned_matches"],
    writes: ["wb_order_matches", "wb_splits", "wb_split_tags"],
  },
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "split_wb_order_charges";
    const ids = absent(args.transaction_ids) ? null : idList(T, "transaction_ids", args.transaction_ids, MAX_ORDER_CHARGE_IDS);
    const { data, error } = await ctx.db.rpc("wb_split_order_charges", { p_transaction_ids: ids });
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});

export const recordWbSubscriptionReviewTool = defineTool({
  name: "record_wb_subscription_review",
  tables: {
    reads: ["wb_subscriptions", "wb_subscription_reviews", "wb_subscription_overview", "contexts"],
    writes: ["wb_subscription_reviews", "wb_subscriptions"],
  },
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "record_wb_subscription_review";
    const subId = uuidOf(T, "subscription_id", args.subscription_id);
    const verdict = oneOf(T, "verdict", args.verdict, REVIEW_VERDICTS);
    if (!verdict) throw new Error(`${T}: verdict is required: ${REVIEW_VERDICTS.join(", ")}. Nothing was changed.`);
    const params = {
      p_subscription_id: subId,
      p_verdict: verdict,
      p_next_review_on: parseDate(T, "next_review_on", args.next_review_on),
      p_reviewed_on: parseDate(T, "reviewed_on", args.reviewed_on),
      p_period_from: parseDate(T, "period_from", args.period_from),
      p_period_to: parseDate(T, "period_to", args.period_to),
      p_uses: optInt(T, "uses", args.uses, 0, 1_000_000),
      p_amount_paid: parseMoney(T, "amount_paid", args.amount_paid),
      p_cost_per_use: parseMoney(T, "cost_per_use", args.cost_per_use),
      p_market_check: optText(T, "market_check", args.market_check),
      p_notes: optText(T, "notes", args.notes),
    };
    // The function's checks and refusals are the rules; they pass through as they are.
    const { data, error } = await ctx.db.rpc("wb_record_subscription_review", params);
    if (error) throw new Error(describeDbError(T, error));
    const review = Object.fromEntries(REVIEW_COLUMNS.split(", ").map((k) => [k, (data as Obj)?.[k] ?? null]));
    const { data: sub, error: se } = await ctx.db.from("wb_subscription_overview")
      .select("id, name, status, review_date, last_reviewed_on, last_verdict").eq("id", subId).maybeSingle();
    if (se) throw new Error(describeDbError(T, se));
    return { review, subscription: sub ?? null };
  },
});
