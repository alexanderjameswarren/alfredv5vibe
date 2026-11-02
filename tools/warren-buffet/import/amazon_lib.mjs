// Warren Buffet Amazon reader and match (spec P4-D7). No network, no file writes.
import { money, pacificDate, parseCsv } from "./history_lib.mjs";

export const ORDERS_FILE = "Your Amazon Orders/Order History.csv";
export const REFUNDS_FILE = "Your Returns & Refunds/Refund Details.csv";
export const FROM_DATE = "2024-09-01";
const RETAIL_SITE = "Amazon.com";
const SITES = { "Amazon.com": "amazon", "wholefoods.com": "wholefoods" };

const ORDER_COLUMNS = {
  order_id: "Order ID", order_date: "Order Date", ship_date: "Ship Date", asin: "ASIN",
  product_name: "Product Name", department: "Department", quantity: "Original Quantity",
  unit_price: "Unit Price", total: "Total Amount", order_status: "Order Status", shipment_status: "Shipment Status",
  payment_method_type: "Payment Method Type",
  // A filter only; never kept on a row.
  website: "Website",
};
const REFUND_COLUMNS = { order_id: "Order ID", refund_date: "Refund Date", amount: "Refund Amount", status: "Payment Status" };

/** Picks only the named columns, by header. Every other column never leaves this function. */
function readColumns(text, columns, label) {
  const [head, ...body] = parseCsv(text);
  const names = (head?.cells ?? []).map((c) => c.trim());
  const at = Object.entries(columns).map(([key, name]) => {
    if (!names.includes(name)) throw new Error(`${label} is missing the column "${name}"`);
    return [key, names.indexOf(name)];
  });
  return body
    .filter(({ cells }) => cells.some((c) => c.trim() !== ""))
    .map(({ line, cells }) => ({
      line,
      wide: cells.length === names.length,
      ...Object.fromEntries(at.map(([key, i]) => [key, (cells[i] ?? "").trim()])),
    }));
}

const timestamp = (s) => (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s) ? pacificDate(s) : null);

export function toCents(amount) {
  return Number(amount.replace(".", ""));
}

/** "Visa - 1234" -> 1234. No digits: a gift card alone, or not available. */
export function cardOf(payment) {
  const last4 = /\b(\d{4})\b/.exec(payment)?.[1];
  if (last4) return last4;
  return /gift/i.test(payment) ? "gift card only" : "not available";
}

/** Items from FROM_DATE on, in shipments by order id and ship date. Other sites, cancelled and unshipped rows are counted, not kept. */
export function readOrders(text) {
  const counts = { rows: 0, before_from: 0, cancelled: 0, no_ship_date: 0, several_ship_dates: 0, zero_total: 0, other_site: {} };
  const bad = [];
  const groups = new Map();
  const otherSite = [];
  const dates = [];
  for (const r of readColumns(text, ORDER_COLUMNS, "Order History")) {
    counts.rows++;
    const orderDate = timestamp(r.order_date);
    const amount = money(r.total);
    if (!r.wide || !orderDate || amount === null) { bad.push(r.line); continue; }
    if (orderDate < FROM_DATE) { counts.before_from++; continue; }
    const unitAmount = money(r.unit_price);
    if (unitAmount === null || !/^\d+$/.test(r.quantity)) { bad.push(r.line); continue; }
    dates.push(orderDate);
    if (r.order_status === "Cancelled") { counts.cancelled++; continue; }
    // One row can name several ship dates ("x and y"); its total cannot be split, so it sits on the earliest.
    const shipDates = r.ship_date.split(" and ").map((s) => timestamp(s.trim()));
    if (shipDates.some((d) => !d)) { counts.no_ship_date++; continue; }
    if (shipDates.length > 1) counts.several_ship_dates++;
    const shipDate = shipDates.slice().sort()[0];
    const key = `${r.order_id}|${shipDate}`;
    const retail = r.website === RETAIL_SITE;
    if (!retail) counts.other_site[r.website || "blank"] = (counts.other_site[r.website || "blank"] ?? 0) + 1;
    const item = {
      site: SITES[r.website] ?? null,
      order_id: r.order_id, order_date: orderDate, ship_date: shipDate, asin: r.asin,
      product_name: r.product_name, department: r.department, quantity: r.quantity, unit_amount: unitAmount, amount,
      order_status: r.order_status, shipment_status: r.shipment_status, payment_method_type: r.payment_method_type,
    };
    if (retail) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    } else if (item.site) otherSite.push({ key, item });
  }
  const toShipment = (items) => ({
    site: items[0].site,
    order_id: items[0].order_id,
    order_date: items[0].order_date,
    ship_date: items[0].ship_date,
    cents: items.reduce((n, i) => n + toCents(i.amount), 0),
    card: cardOf(items[0].payment_method_type),
    part_gift_card: /gift/i.test(items[0].payment_method_type) && /\d{4}/.test(items[0].payment_method_type),
    items,
  });
  const all = [...groups.values()].map(toShipment);
  const shipments = all.filter((s) => s.cents > 0);
  counts.zero_total = all.length - shipments.length;
  const other = new Map();
  for (const { key, item } of otherSite) other.set(key, [...(other.get(key) ?? []), item]);
  dates.sort();
  return {
    shipments, counts, bad,
    zeroShipments: all.filter((s) => s.cents <= 0),
    otherSiteShipments: [...other.values()].map(toShipment),
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
  };
}

/** Refunds on the given orders. A row with no refund date or amount is counted, not an error. */
export function readRefunds(text, orderIds) {
  const refunds = [];
  const bad = [];
  let rows = 0, notApplicable = 0, otherOrders = 0;
  for (const r of readColumns(text, REFUND_COLUMNS, "Refund Details")) {
    rows++;
    if (!orderIds.has(r.order_id)) { otherOrders++; continue; }
    if (r.refund_date === "Not Applicable" || r.amount === "Not Applicable") { notApplicable++; continue; }
    const date = timestamp(r.refund_date);
    const amount = money(r.amount);
    if (!r.wide || !date || amount === null) { bad.push(r.line); continue; }
    refunds.push({ order_id: r.order_id, refund_date: date, amount, status: r.status });
  }
  return { refunds, rows, notApplicable, otherOrders, bad };
}

/**
 * Refund Details names an order, not an item. A refund lands on the order's only line, or on a line
 * not yet refunded whose total is exactly the refund. Anything else is counted as unplaced, never guessed.
 */
export function placeRefunds(shipments, refunds) {
  const byOrder = new Map();
  for (const s of shipments) byOrder.set(s.order_id, [...(byOrder.get(s.order_id) ?? []), ...s.items]);
  let placed = 0, unplaced = 0;
  const oldestFirst = refunds.slice().sort((a, b) => (a.refund_date < b.refund_date ? -1 : a.refund_date > b.refund_date ? 1 : 0));
  for (const r of oldestFirst) {
    const items = byOrder.get(r.order_id) ?? [];
    const cents = toCents(r.amount);
    const item = items.length === 1 ? items[0] : items.find((i) => !i.refunded_cents && toCents(i.amount) === cents);
    if (!item || cents <= 0) { unplaced++; continue; }
    item.refunded_cents = (item.refunded_cents ?? 0) + cents;
    item.refund_date = r.refund_date;
    placed++;
  }
  return { placed, unplaced };
}

/** What an Amazon-named debit is. Only "shipment" can match an order; the rest never appear in Order History. */
export function chargeType(text) {
  const t = text.toLowerCase();
  if (/\bprime\b|amzn prime|amazonprime/.test(t) && !/prime now/.test(t)) return "prime or video";
  if (/digital|kindle|audible|music|prime video/.test(t)) return "digital";
  if (/web services|\baws\b/.test(t)) return "web services";
  if (/\btips?\b/.test(t)) return "tips";
  return "shipment";
}

export function isAmazonText(text) {
  return /amazon|amzn/i.test(text);
}

function dayGap(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function quarterOf(date) {
  return `${date.slice(0, 4)} Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
}

/** Shipments of the exact amount, shipped 0 to maxDays before the charge. */
export function candidates(charge, shipments, maxDays) {
  return shipments.filter((s) => {
    if (s.cents !== charge.cents) return false;
    const gap = dayGap(s.ship_date, charge.date);
    return gap >= 0 && gap <= maxDays;
  });
}

/** P4-D7: exact amount, 0 to 3 days, one shipment only. A shipment two charges would claim stays unmatched. */
export function chooseMatches(charges, shipments) {
  const claims = new Map();
  for (const charge of charges) {
    const found = candidates(charge, shipments, 3);
    if (found.length !== 1) continue;
    claims.set(found[0], [...(claims.get(found[0]) ?? []), charge]);
  }
  const matches = [];
  let shared = 0;
  for (const [shipment, list] of claims) {
    if (list.length > 1) { shared++; continue; }
    matches.push({ shipment, charge: list[0], days_apart: dayGap(shipment.ship_date, list[0].date) });
  }
  return { matches, shared };
}

const outcome = (n) => (n === 0 ? "none" : n === 1 ? "one" : "many");

const emptyLine = () => ({ charges: 0, d3_one: 0, d3_many: 0, d3_none: 0, d7_one: 0, d7_many: 0, d7_none: 0 });

function bump(map, key, c3, c7) {
  const line = map[key] ??= emptyLine();
  line.charges++;
  line[`d3_${outcome(c3)}`]++;
  line[`d7_${outcome(c7)}`]++;
}

/** Counts only; nothing here carries an amount, a name or an order id out. */
export function matchAll(charges, shipments) {
  const total = emptyLine();
  const byCard = {}, byQuarter = {};
  const matched = new Map();
  for (const c of charges) {
    const c3 = candidates(c, shipments, 3);
    const c7 = candidates(c, shipments, 7);
    total.charges++;
    total[`d3_${outcome(c3.length)}`]++;
    total[`d7_${outcome(c7.length)}`]++;
    bump(byCard, c.card, c3.length, c7.length);
    bump(byQuarter, quarterOf(c.date), c3.length, c7.length);
    for (const s of c7) matched.set(s, (matched.get(s) ?? 0) + 1);
  }
  const noCharge = shipments.filter((s) => !matched.has(s));
  const shipLines = (keyOf) => {
    const out = {};
    for (const s of shipments) (out[keyOf(s)] ??= { shipments: 0, no_charge: 0 }).shipments++;
    for (const s of noCharge) out[keyOf(s)].no_charge++;
    return out;
  };
  return {
    total, byCard, byQuarter,
    shipments: shipments.length,
    noCharge: noCharge.length,
    noChargePartGift: noCharge.filter((s) => s.part_gift_card).length,
    sharedShipments: [...matched.values()].filter((n) => n > 1).length,
    shipByCard: shipLines((s) => s.card),
    shipByQuarter: shipLines((s) => quarterOf(s.ship_date)),
  };
}
