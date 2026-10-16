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

// wb_rule_health_all (131_wb_phase2_step10_acks.sql). Help: rule_health.*.
export const NEVER_FIRES_AFTER_DAYS = 14;
export const NEVER_FIRES_SKIP_MONTHS = 3;
export const TOO_BROAD_PAYEES = 3;
export const OVERRIDDEN_MIN = 2;
export const OVERRIDDEN_SHARE_DIVISOR = 4; // "at least a quarter": n * 4 >= hits
export const DUPLICATE_RULES_MIN = 2;
export const RULE_MISSING_MIN = 3;
