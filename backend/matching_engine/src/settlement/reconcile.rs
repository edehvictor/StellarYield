//! # Settlement reconciliation
//!
//! A trade exists as soon as the matcher pairs two orders, but it only counts
//! once it has been committed on-chain. If the node stops between the two
//! steps (a crash, a restart, a rejected or lost submission) the match record
//! is left behind with no final settlement.
//!
//! [`SettlementLedger`] is the record of that gap. Every match is recorded
//! before settlement is attempted, every attempt and its outcome is recorded
//! next to it, and [`SettlementLedger::reconcile`] lists the trades that are
//! matched but not committed together with a [`RetryStatus`] saying whether a
//! retry is due, still backing off, or has run out of attempts. The ledger
//! serialises to JSON so it can be persisted and reloaded after a crash.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::orderbook::Trade;

/// How long after a match a trade may stay unsettled before it is retried
pub const DEFAULT_GRACE_MS: u64 = 30_000;
/// Base delay between settlement attempts; doubles after every failed attempt
pub const DEFAULT_RETRY_BACKOFF_MS: u64 = 15_000;
/// Settlement attempts made before a trade is reported as exhausted
pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;

/// Largest exponent used for the retry backoff (`base * 2^16`)
const MAX_BACKOFF_EXPONENT: u32 = 16;

/// Tuning for reconciliation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconcileConfig {
    /// Time after the match before an unattempted trade is due for settlement
    pub grace_ms: u64,
    /// Base retry delay; the delay after attempt `n` is `base * 2^(n-1)`
    pub retry_backoff_ms: u64,
    /// Attempts after which a trade is no longer retried automatically
    pub max_attempts: u32,
}

impl Default for ReconcileConfig {
    fn default() -> Self {
        Self {
            grace_ms: DEFAULT_GRACE_MS,
            retry_backoff_ms: DEFAULT_RETRY_BACKOFF_MS,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
        }
    }
}

/// Where a matched trade is in settlement
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettlementState {
    /// Matched; no settlement attempt is in flight
    Matched,
    /// A settlement attempt was started and has no recorded outcome yet. After
    /// a restart this means the outcome is unknown and the trade is retried.
    Submitted,
    /// Settled on-chain
    Committed,
}

/// What reconciliation says about retrying a trade
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RetryStatus {
    /// Due now
    Ready,
    /// Retry later, not before `retry_at_ms`
    Waiting { retry_at_ms: u64 },
    /// Out of attempts; needs manual attention
    Exhausted,
}

/// Errors raised by ledger updates
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LedgerError {
    #[error("trade {0} is not in the settlement ledger")]
    UnknownTrade(String),
    #[error("trade {0} is already committed")]
    AlreadyCommitted(String),
    #[error("trade {trade_id} is already committed as {existing}, not {attempted}")]
    CommitConflict {
        trade_id: String,
        existing: String,
        attempted: String,
    },
    #[error("trade {0} has used all its settlement attempts")]
    AttemptsExhausted(String),
    #[error("ledger could not be encoded or decoded: {0}")]
    Serialization(String),
}

/// The match record of one trade and its settlement progress
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TradeRecord {
    pub trade: Trade,
    pub matched_at_ms: u64,
    pub state: SettlementState,
    /// Settlement attempts started so far
    pub attempts: u32,
    pub last_attempt_at_ms: Option<u64>,
    pub last_error: Option<String>,
    /// On-chain reference (e.g. a transaction hash) once committed
    pub settlement_ref: Option<String>,
}

/// A trade that is matched but not committed
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingTrade {
    pub trade_id: String,
    pub state: SettlementState,
    pub attempts: u32,
    pub matched_at_ms: u64,
    /// How long the trade has been waiting, as of the reconciliation time
    pub age_ms: u64,
    pub last_error: Option<String>,
    pub retry: RetryStatus,
}

/// Result of [`SettlementLedger::reconcile`]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciliationReport {
    /// Time the report was made for
    pub as_of_ms: u64,
    /// Trades that are committed
    pub committed: usize,
    /// Trades that are matched but not committed, oldest match first
    pub pending: Vec<PendingTrade>,
}

impl ReconciliationReport {
    /// Pending trades whose retry is due now
    pub fn ready(&self) -> impl Iterator<Item = &PendingTrade> {
        self.pending
            .iter()
            .filter(|p| p.retry == RetryStatus::Ready)
    }

    /// Pending trades that are still backing off
    pub fn waiting(&self) -> impl Iterator<Item = &PendingTrade> {
        self.pending
            .iter()
            .filter(|p| matches!(p.retry, RetryStatus::Waiting { .. }))
    }

    /// Pending trades that have used all their attempts
    pub fn exhausted(&self) -> impl Iterator<Item = &PendingTrade> {
        self.pending
            .iter()
            .filter(|p| p.retry == RetryStatus::Exhausted)
    }

    /// True when every trade is committed
    pub fn is_clean(&self) -> bool {
        self.pending.is_empty()
    }
}

/// Durable record of matched trades and their settlement progress
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettlementLedger {
    config: ReconcileConfig,
    /// Keyed by trade ID so iteration and serialisation are deterministic
    records: BTreeMap<String, TradeRecord>,
}

impl SettlementLedger {
    pub fn new(config: ReconcileConfig) -> Self {
        Self {
            config,
            records: BTreeMap::new(),
        }
    }

    pub fn config(&self) -> ReconcileConfig {
        self.config
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn get(&self, trade_id: &str) -> Option<&TradeRecord> {
        self.records.get(trade_id)
    }

    /// Record a freshly matched trade. Call this before attempting
    /// settlement, so a crash right after the match still leaves a record.
    /// Returns `false` (and changes nothing) if the trade is already recorded.
    pub fn record_match(&mut self, trade: &Trade, now_ms: u64) -> bool {
        if self.records.contains_key(&trade.id) {
            return false;
        }
        self.records.insert(
            trade.id.clone(),
            TradeRecord {
                trade: trade.clone(),
                matched_at_ms: now_ms,
                state: SettlementState::Matched,
                attempts: 0,
                last_attempt_at_ms: None,
                last_error: None,
                settlement_ref: None,
            },
        );
        true
    }

    /// Record every trade of a match result; returns how many were new
    pub fn record_matches(&mut self, trades: &[Trade], now_ms: u64) -> usize {
        trades
            .iter()
            .filter(|trade| self.record_match(trade, now_ms))
            .count()
    }

    /// Note that a settlement attempt is starting. Returns the attempt number.
    pub fn begin_attempt(&mut self, trade_id: &str, now_ms: u64) -> Result<u32, LedgerError> {
        let max_attempts = self.config.max_attempts;
        let record = self.record_mut(trade_id)?;
        if record.state == SettlementState::Committed {
            return Err(LedgerError::AlreadyCommitted(trade_id.to_string()));
        }
        if record.attempts >= max_attempts {
            return Err(LedgerError::AttemptsExhausted(trade_id.to_string()));
        }
        record.attempts += 1;
        record.state = SettlementState::Submitted;
        record.last_attempt_at_ms = Some(now_ms);
        Ok(record.attempts)
    }

    /// Note that the trade settled on-chain as `settlement_ref`. Repeating the
    /// call with the same reference is harmless; a different one is rejected.
    pub fn mark_committed(
        &mut self,
        trade_id: &str,
        settlement_ref: &str,
    ) -> Result<(), LedgerError> {
        let record = self.record_mut(trade_id)?;
        if record.state == SettlementState::Committed {
            return match record.settlement_ref.as_deref() {
                Some(existing) if existing == settlement_ref => Ok(()),
                existing => Err(LedgerError::CommitConflict {
                    trade_id: trade_id.to_string(),
                    existing: existing.unwrap_or_default().to_string(),
                    attempted: settlement_ref.to_string(),
                }),
            };
        }
        record.state = SettlementState::Committed;
        record.settlement_ref = Some(settlement_ref.to_string());
        record.last_error = None;
        Ok(())
    }

    /// Note that a settlement attempt failed. The trade goes back to
    /// `Matched` and the returned status says when it may be retried.
    pub fn mark_failed(
        &mut self,
        trade_id: &str,
        error: &str,
        now_ms: u64,
    ) -> Result<RetryStatus, LedgerError> {
        let config = self.config;
        let record = self.record_mut(trade_id)?;
        if record.state == SettlementState::Committed {
            return Err(LedgerError::AlreadyCommitted(trade_id.to_string()));
        }
        record.state = SettlementState::Matched;
        record.last_attempt_at_ms.get_or_insert(now_ms);
        record.last_error = Some(error.to_string());
        Ok(retry_status(&config, record, now_ms))
    }

    /// List the trades that are matched but not committed, with retry status
    /// as of `now_ms`. Does not change the ledger.
    pub fn reconcile(&self, now_ms: u64) -> ReconciliationReport {
        let mut committed = 0;
        let mut pending: Vec<PendingTrade> = Vec::new();
        for (trade_id, record) in &self.records {
            if record.state == SettlementState::Committed {
                committed += 1;
                continue;
            }
            pending.push(PendingTrade {
                trade_id: trade_id.clone(),
                state: record.state,
                attempts: record.attempts,
                matched_at_ms: record.matched_at_ms,
                age_ms: now_ms.saturating_sub(record.matched_at_ms),
                last_error: record.last_error.clone(),
                retry: retry_status(&self.config, record, now_ms),
            });
        }
        pending.sort_by(|a, b| {
            a.matched_at_ms
                .cmp(&b.matched_at_ms)
                .then_with(|| a.trade_id.cmp(&b.trade_id))
        });
        ReconciliationReport {
            as_of_ms: now_ms,
            committed,
            pending,
        }
    }

    /// Serialise the ledger so it can be written to durable storage
    pub fn to_json(&self) -> Result<String, LedgerError> {
        serde_json::to_string(self).map_err(|e| LedgerError::Serialization(e.to_string()))
    }

    /// Load a ledger written by [`SettlementLedger::to_json`], e.g. after a restart
    pub fn from_json(json: &str) -> Result<Self, LedgerError> {
        serde_json::from_str(json).map_err(|e| LedgerError::Serialization(e.to_string()))
    }

    fn record_mut(&mut self, trade_id: &str) -> Result<&mut TradeRecord, LedgerError> {
        self.records
            .get_mut(trade_id)
            .ok_or_else(|| LedgerError::UnknownTrade(trade_id.to_string()))
    }
}

/// When a trade may next be retried
fn retry_status(config: &ReconcileConfig, record: &TradeRecord, now_ms: u64) -> RetryStatus {
    if record.attempts >= config.max_attempts {
        return RetryStatus::Exhausted;
    }
    let retry_at_ms = match record.last_attempt_at_ms {
        // Never attempted: allow the grace period for the normal settlement path.
        None => record.matched_at_ms.checked_add(config.grace_ms),
        // Back off exponentially after each attempt: base * 2^(attempts - 1).
        Some(last) => {
            let exponent = record.attempts.saturating_sub(1).min(MAX_BACKOFF_EXPONENT);
            config
                .retry_backoff_ms
                .checked_mul(1u64 << exponent)
                .and_then(|delay| last.checked_add(delay))
        }
    }
    .unwrap_or(u64::MAX);

    if now_ms >= retry_at_ms {
        RetryStatus::Ready
    } else {
        RetryStatus::Waiting { retry_at_ms }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matching::MatchingEngine;
    use crate::orderbook::{Order, OrderType, Side};

    const CONFIG: ReconcileConfig = ReconcileConfig {
        grace_ms: 1_000,
        retry_backoff_ms: 500,
        max_attempts: 3,
    };

    fn trade(id: &str) -> Trade {
        let maker = Order::new(
            "maker".to_string(),
            Side::Sell,
            OrderType::Limit,
            100,
            10,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        );
        let taker = Order::new(
            "taker".to_string(),
            Side::Buy,
            OrderType::Limit,
            100,
            10,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        );
        let mut trade = Trade::new(&maker, &taker, 10, 100);
        trade.id = id.to_string();
        trade
    }

    fn ledger() -> SettlementLedger {
        SettlementLedger::new(CONFIG)
    }

    #[test]
    fn a_match_with_no_settlement_is_reported_as_pending() {
        let mut ledger = ledger();
        assert!(ledger.record_match(&trade("t1"), 10_000));

        let report = ledger.reconcile(10_100);
        assert!(!report.is_clean());
        assert_eq!(report.committed, 0);
        assert_eq!(report.pending.len(), 1);
        let pending = &report.pending[0];
        assert_eq!(pending.trade_id, "t1");
        assert_eq!(pending.state, SettlementState::Matched);
        assert_eq!(pending.attempts, 0);
        assert_eq!(pending.age_ms, 100);
        // Still inside the grace period for the normal settlement path.
        assert_eq!(
            pending.retry,
            RetryStatus::Waiting {
                retry_at_ms: 11_000
            }
        );
    }

    #[test]
    fn an_unsettled_match_becomes_retryable_after_the_grace_period() {
        let mut ledger = ledger();
        ledger.record_match(&trade("t1"), 10_000);

        let report = ledger.reconcile(11_000);
        assert_eq!(report.ready().count(), 1);
        assert_eq!(report.waiting().count(), 0);
        assert_eq!(report.ready().next().unwrap().trade_id, "t1");
    }

    #[test]
    fn crash_between_match_and_settlement_is_recovered_from_the_persisted_ledger() {
        let mut before_crash = ledger();
        before_crash.record_match(&trade("t1"), 10_000);
        before_crash.record_match(&trade("t2"), 10_000);
        // t1 settles; the node dies after matching t2 and before settling it.
        before_crash.begin_attempt("t1", 10_100).unwrap();
        before_crash.mark_committed("t1", "tx-1").unwrap();
        let persisted = before_crash.to_json().unwrap();
        drop(before_crash);

        let after_restart = SettlementLedger::from_json(&persisted).unwrap();
        let report = after_restart.reconcile(12_000);

        assert_eq!(report.committed, 1);
        let stuck: Vec<&str> = report.ready().map(|p| p.trade_id.as_str()).collect();
        assert_eq!(stuck, vec!["t2"]);
        assert_eq!(
            after_restart,
            SettlementLedger::from_json(&persisted).unwrap()
        );
    }

    #[test]
    fn crash_during_a_settlement_attempt_is_retried_with_backoff() {
        let mut before_crash = ledger();
        before_crash.record_match(&trade("t1"), 10_000);
        assert_eq!(before_crash.begin_attempt("t1", 11_000).unwrap(), 1);
        // The node dies here: the attempt has no recorded outcome.
        let persisted = before_crash.to_json().unwrap();

        let after_restart = SettlementLedger::from_json(&persisted).unwrap();
        let early = after_restart.reconcile(11_100);
        assert_eq!(early.pending[0].state, SettlementState::Submitted);
        assert_eq!(early.pending[0].attempts, 1);
        assert_eq!(
            early.pending[0].retry,
            RetryStatus::Waiting {
                retry_at_ms: 11_500
            }
        );

        let later = after_restart.reconcile(11_500);
        assert_eq!(later.pending[0].retry, RetryStatus::Ready);
    }

    #[test]
    fn failed_attempts_back_off_exponentially_and_then_are_exhausted() {
        let mut ledger = ledger();
        ledger.record_match(&trade("t1"), 0);

        ledger.begin_attempt("t1", 1_000).unwrap();
        assert_eq!(
            ledger.mark_failed("t1", "rpc timeout", 1_000).unwrap(),
            RetryStatus::Waiting { retry_at_ms: 1_500 }
        );

        ledger.begin_attempt("t1", 1_500).unwrap();
        assert_eq!(
            ledger.mark_failed("t1", "rpc timeout", 1_500).unwrap(),
            RetryStatus::Waiting { retry_at_ms: 2_500 }
        );

        ledger.begin_attempt("t1", 2_500).unwrap();
        assert_eq!(
            ledger
                .mark_failed("t1", "contract rejected", 2_500)
                .unwrap(),
            RetryStatus::Exhausted
        );

        let report = ledger.reconcile(1_000_000);
        assert_eq!(report.exhausted().count(), 1);
        assert_eq!(report.ready().count(), 0);
        assert_eq!(
            report.pending[0].last_error.as_deref(),
            Some("contract rejected")
        );
        assert_eq!(
            ledger.begin_attempt("t1", 1_000_001),
            Err(LedgerError::AttemptsExhausted("t1".to_string()))
        );
    }

    #[test]
    fn committing_clears_the_trade_from_the_pending_list() {
        let mut ledger = ledger();
        ledger.record_match(&trade("t1"), 0);
        ledger.begin_attempt("t1", 1_000).unwrap();
        ledger.mark_failed("t1", "boom", 1_000).unwrap();
        ledger.begin_attempt("t1", 2_000).unwrap();
        ledger.mark_committed("t1", "tx-9").unwrap();

        let report = ledger.reconcile(3_000);
        assert!(report.is_clean());
        assert_eq!(report.committed, 1);
        let record = ledger.get("t1").unwrap();
        assert_eq!(record.settlement_ref.as_deref(), Some("tx-9"));
        assert_eq!(record.last_error, None);
    }

    #[test]
    fn recording_and_committing_are_idempotent_but_conflicts_are_rejected() {
        let mut ledger = ledger();
        assert!(ledger.record_match(&trade("t1"), 0));
        assert!(
            !ledger.record_match(&trade("t1"), 5_000),
            "a repeat changes nothing"
        );
        assert_eq!(ledger.get("t1").unwrap().matched_at_ms, 0);
        assert_eq!(ledger.len(), 1);

        ledger.mark_committed("t1", "tx-1").unwrap();
        ledger.mark_committed("t1", "tx-1").unwrap();
        assert_eq!(
            ledger.mark_committed("t1", "tx-2"),
            Err(LedgerError::CommitConflict {
                trade_id: "t1".to_string(),
                existing: "tx-1".to_string(),
                attempted: "tx-2".to_string()
            })
        );
        assert_eq!(
            ledger.begin_attempt("t1", 1),
            Err(LedgerError::AlreadyCommitted("t1".to_string()))
        );
        assert_eq!(
            ledger.mark_failed("t1", "late failure", 1),
            Err(LedgerError::AlreadyCommitted("t1".to_string()))
        );
    }

    #[test]
    fn unknown_trades_are_rejected() {
        let mut ledger = ledger();
        for result in [
            ledger.begin_attempt("nope", 0).map(|_| ()),
            ledger.mark_committed("nope", "tx"),
            ledger.mark_failed("nope", "x", 0).map(|_| ()),
        ] {
            assert_eq!(result, Err(LedgerError::UnknownTrade("nope".to_string())));
        }
    }

    #[test]
    fn pending_trades_are_listed_oldest_match_first() {
        let mut ledger = ledger();
        ledger.record_match(&trade("b"), 2_000);
        ledger.record_match(&trade("a"), 2_000);
        ledger.record_match(&trade("c"), 1_000);

        let ids: Vec<String> = ledger
            .reconcile(5_000)
            .pending
            .into_iter()
            .map(|p| p.trade_id)
            .collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn huge_attempt_counts_and_times_do_not_overflow() {
        let config = ReconcileConfig {
            grace_ms: u64::MAX,
            retry_backoff_ms: u64::MAX,
            max_attempts: u32::MAX,
        };
        let mut ledger = SettlementLedger::new(config);
        ledger.record_match(&trade("t1"), u64::MAX - 1);
        ledger.begin_attempt("t1", u64::MAX - 1).unwrap();
        ledger.mark_failed("t1", "x", u64::MAX - 1).unwrap();
        // The delay overflows, so the trade simply stays in the future rather than panicking.
        let report = ledger.reconcile(u64::MAX - 1);
        assert_eq!(
            report.pending[0].retry,
            RetryStatus::Waiting {
                retry_at_ms: u64::MAX
            }
        );
    }

    #[test]
    fn trades_from_the_matching_engine_flow_into_the_ledger() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(Order::new(
            "maker".to_string(),
            Side::Sell,
            OrderType::Limit,
            100,
            1_000,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        ));
        let result = engine.submit_order(Order::new(
            "taker".to_string(),
            Side::Buy,
            OrderType::Limit,
            100,
            300,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        ));

        let mut ledger = ledger();
        assert_eq!(ledger.record_matches(&result.trades, 50_000), 1);
        assert_eq!(ledger.record_matches(&result.trades, 50_001), 0);

        let report = ledger.reconcile(60_000);
        assert_eq!(report.ready().count(), 1);
        assert_eq!(report.pending[0].trade_id, result.trades[0].id);
    }
}
