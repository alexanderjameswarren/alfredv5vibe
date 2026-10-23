// Numbers that live in SQL, mirrored here so the help wording can be tested
// against them. helpText.test.js reads each SQL source below and fails if the
// two disagree. If you change one of these values (here or in its SQL), update
// the help entry named beside it in src/money/helpText.js and the test.

// wb_transfer_match (103_wb_phase2_tables.sql); also findPairCandidates.
// Help: review.transfer_candidate, transaction.transfer.
export const TRANSFER_WINDOW_DAYS = 5;

// wb_detect_subscriptions (120_wb_phase2_step7_subscriptions.sql).
// Help: review.new_recurring, subscription.status.watching.
export const DETECT_MIN_CHARGES = 3;
export const DETECT_LOOKBACK_DAYS = 120;
export const DETECT_GAP_MIN_DAYS = 26;
export const DETECT_GAP_MAX_DAYS = 35;
export const DETECT_SPREAD_PERCENT = 10;

// wb_subscription_overview, overdue (124_wb_phase2_step8_interval_links.sql).
// Help: subscription.status.overdue.
export const OVERDUE_GRACE_DAYS = 7;

// wb_burn_rate_on (Phase 3 step 5 migration), v_months. Help: overview.burn_rate, overview.true_cost.
export const BURN_MONTHS = 3;

// wb_rule_health_all (the Phase 3 step 10 migration). Help: rule_health.*.
// never_fires (A54, A55): flagged once quiet for more than NEVER_FIRES_FACTOR times the expected interval
// and more than NEVER_FIRES_FLOOR_DAYS; the interval falls back to the annual or quarterly notes days,
// then NEVER_FIRES_DEFAULT_DAYS. All are the params row of wb_rule_health_all.
export const NEVER_FIRES_FACTOR = 1.5;
export const NEVER_FIRES_FLOOR_DAYS = 30;
export const NEVER_FIRES_DEFAULT_DAYS = 30;
export const NEVER_FIRES_QUARTER_DAYS = 91;
export const NEVER_FIRES_ANNUAL_DAYS = 365;
export const TOO_BROAD_PAYEES = 3;
export const OVERRIDDEN_MIN = 2;
export const OVERRIDDEN_SHARE_DIVISOR = 4; // "at least a quarter": n * 4 >= hits
export const DUPLICATE_RULES_MIN = 2;
export const RULE_MISSING_MIN = 3;

// wb_action_items (Phase 3 step 9 migrations): the defaults of p_days, p_big_amount and
// p_big_days, and c_flow_days. Help: overview.next_days, overview.major_expenses, overview.cash_flow.
export const ACTION_DAYS = 14;
export const ACTION_BIG_AMOUNT = 1000;
export const ACTION_BIG_DAYS = 60;
export const CASH_FLOW_DAYS = 30;
// wb_action_items c_move_days (A58) and c_flag_days (A53). Help: overview.funds_transfer, overview.red_flags.
export const FUNDS_TRANSFER_DAYS = 30;
export const FLAG_DAYS = 90;
