//! # Cross-node tie breaking
//!
//! Gossiped orders reach peers in different arrival orders. If two orders
//! carry the same timestamp, ordering them by arrival would let peers match
//! them in a different sequence and produce divergent trades.
//!
//! Every peer instead ranks orders by a canonical [`MatchPriority`]:
//! the order timestamp first, then the order ID as a tie breaker. Both fields
//! travel with the order, so all peers derive the same ranking regardless of
//! arrival order. [`MatchSequencer`] applies the same ranking to the stream of
//! incoming orders before they are handed to the matcher.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::orderbook::Order;

/// Default time an order is held back so that colliding orders from other
/// peers can arrive before it is released to the matcher.
pub const DEFAULT_TIE_WINDOW_MS: u64 = 250;

/// Canonical match priority shared by all peers.
///
/// Lower values match first: earlier timestamps win and, on equal timestamps,
/// the lexicographically smaller order ID wins.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MatchPriority {
    /// Order timestamp in milliseconds
    pub timestamp: u64,
    /// Order ID, used to break timestamp collisions
    pub order_id: String,
}

impl MatchPriority {
    /// Derive the priority of an order
    pub fn of(order: &Order) -> Self {
        Self {
            timestamp: order.timestamp,
            order_id: order.id.clone(),
        }
    }
}

/// Compare two orders by canonical match priority
pub fn canonical_cmp(a: &Order, b: &Order) -> Ordering {
    a.timestamp.cmp(&b.timestamp).then_with(|| a.id.cmp(&b.id))
}

/// Sort orders into canonical match order
pub fn sort_canonical(orders: &mut [Order]) {
    orders.sort_by(canonical_cmp);
}

/// Result of offering an order to a [`MatchSequencer`]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceOutcome {
    /// Order queued in canonical position
    Queued,
    /// An order with the same ID is already queued
    Duplicate,
    /// Order ranks before an order that was already released, so this node
    /// may have matched out of canonical order. It is still queued; callers
    /// should treat this as a signal to resync with peers.
    Late,
}

/// Buffers incoming orders and releases them in canonical match order.
///
/// An order is released once `window_ms` has passed since its timestamp,
/// giving colliding orders from other peers time to arrive.
#[derive(Debug)]
pub struct MatchSequencer {
    window_ms: u64,
    pending: BTreeMap<MatchPriority, Order>,
    last_released: Option<MatchPriority>,
}

impl MatchSequencer {
    /// Create a sequencer with the given collision window
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            pending: BTreeMap::new(),
            last_released: None,
        }
    }

    /// Offer an order to the sequencer
    pub fn push(&mut self, order: Order) -> SequenceOutcome {
        if self.pending.values().any(|o| o.id == order.id) {
            return SequenceOutcome::Duplicate;
        }
        let priority = MatchPriority::of(&order);
        let late = self
            .last_released
            .as_ref()
            .is_some_and(|released| &priority < released);
        self.pending.insert(priority, order);
        if late {
            SequenceOutcome::Late
        } else {
            SequenceOutcome::Queued
        }
    }

    /// Release, in canonical order, every order whose collision window has
    /// elapsed at `now_ms`
    pub fn drain_ready(&mut self, now_ms: u64) -> Vec<Order> {
        let cutoff = now_ms.saturating_sub(self.window_ms);
        let mut ready = Vec::new();
        while let Some(entry) = self.pending.first_entry() {
            if entry.key().timestamp > cutoff {
                break;
            }
            let (priority, order) = entry.remove_entry();
            self.last_released = Some(priority);
            ready.push(order);
        }
        ready
    }

    /// Release every pending order in canonical order
    pub fn drain_all(&mut self) -> Vec<Order> {
        self.drain_ready(u64::MAX)
    }

    /// Number of orders waiting to be released
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Whether no orders are waiting
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

impl Default for MatchSequencer {
    fn default() -> Self {
        Self::new(DEFAULT_TIE_WINDOW_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matching::MatchingEngine;
    use crate::orderbook::{OrderType, Side, Trade};

    const TS: u64 = 1_700_000_000_000;

    fn order(id: &str, trader: &str, side: Side, price: u128, amount: u128, ts: u64) -> Order {
        let mut o = Order::new(
            trader.to_string(),
            side,
            OrderType::Limit,
            price,
            amount,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        );
        o.id = id.to_string();
        o.timestamp = ts;
        o
    }

    fn fingerprint(trades: &[Trade]) -> Vec<(String, String, u128, u128)> {
        trades
            .iter()
            .map(|t| {
                (
                    t.maker_order_id.clone(),
                    t.taker_order_id.clone(),
                    t.price,
                    t.amount,
                )
            })
            .collect()
    }

    /// Feed `arrivals` through a sequencer into a fresh engine, as a peer would.
    fn run_peer(arrivals: Vec<Order>) -> Vec<(String, String, u128, u128)> {
        let mut sequencer = MatchSequencer::default();
        for o in arrivals {
            assert_eq!(sequencer.push(o), SequenceOutcome::Queued);
        }
        let mut engine = MatchingEngine::new();
        let mut trades = Vec::new();
        for o in sequencer.drain_all() {
            trades.extend(engine.submit_order(o).trades);
        }
        fingerprint(&trades)
    }

    #[test]
    fn test_canonical_cmp_breaks_timestamp_ties_by_id() {
        let a = order("a", "t", Side::Sell, 100, 1, TS);
        let b = order("b", "t", Side::Sell, 100, 1, TS);
        let earlier = order("z", "t", Side::Sell, 100, 1, TS - 1);

        assert_eq!(canonical_cmp(&a, &b), Ordering::Less);
        assert_eq!(canonical_cmp(&b, &a), Ordering::Greater);
        // Timestamp still dominates the ID.
        assert_eq!(canonical_cmp(&earlier, &a), Ordering::Less);

        let mut orders = vec![b.clone(), earlier.clone(), a.clone()];
        sort_canonical(&mut orders);
        let ids: Vec<_> = orders.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["z", "a", "b"]);
    }

    #[test]
    fn test_equal_timestamps_rest_in_same_order_regardless_of_arrival() {
        let a = order("order-a", "alice", Side::Sell, 100, 500, TS);
        let b = order("order-b", "bob", Side::Sell, 100, 500, TS);

        let mut peer1 = MatchingEngine::new();
        peer1.submit_order(a.clone());
        peer1.submit_order(b.clone());

        let mut peer2 = MatchingEngine::new();
        peer2.submit_order(b.clone());
        peer2.submit_order(a.clone());

        let level1 = &peer1.get_book("token0-token1").unwrap().asks.levels[&100];
        let level2 = &peer2.get_book("token0-token1").unwrap().asks.levels[&100];
        assert_eq!(level1.orders, level2.orders);
        assert_eq!(level1.orders.front().unwrap(), "order-a");

        // A taker that only fills one maker hits the same maker on both peers.
        let taker = order("taker", "carol", Side::Buy, 100, 500, TS + 1);
        let t1 = peer1.submit_order(taker.clone()).trades;
        let t2 = peer2.submit_order(taker).trades;
        assert_eq!(fingerprint(&t1), fingerprint(&t2));
        assert_eq!(t1[0].maker_order_id, "order-a");
    }

    #[test]
    fn test_equal_timestamp_takers_match_identically_across_peers() {
        let maker = order("maker", "mm", Side::Sell, 100, 600, TS - 10);
        let taker_x = order("taker-x", "xavier", Side::Buy, 100, 400, TS);
        let taker_y = order("taker-y", "yara", Side::Buy, 100, 400, TS);

        let peer1 = run_peer(vec![maker.clone(), taker_x.clone(), taker_y.clone()]);
        let peer2 = run_peer(vec![taker_y.clone(), maker.clone(), taker_x.clone()]);
        let peer3 = run_peer(vec![taker_y, taker_x, maker]);

        assert_eq!(peer1, peer2);
        assert_eq!(peer1, peer3);
        // taker-x wins the tie and is filled in full; taker-y gets the rest.
        assert_eq!(
            peer1,
            vec![
                ("maker".to_string(), "taker-x".to_string(), 100, 400),
                ("maker".to_string(), "taker-y".to_string(), 100, 200),
            ]
        );
    }

    #[test]
    fn test_distinct_timestamps_keep_time_priority() {
        // Outside of collisions, earlier orders still win even when the ID
        // would sort later, so existing price-time priority is unchanged.
        let first = order("zzz", "alice", Side::Sell, 100, 500, TS);
        let second = order("aaa", "bob", Side::Sell, 100, 500, TS + 1);

        let mut engine = MatchingEngine::new();
        engine.submit_order(second);
        engine.submit_order(first);

        let taker = order("taker", "carol", Side::Buy, 100, 500, TS + 2);
        let trades = engine.submit_order(taker).trades;
        assert_eq!(trades[0].maker_order_id, "zzz");
    }

    #[test]
    fn test_sequencer_holds_orders_until_window_elapses() {
        let mut sequencer = MatchSequencer::new(100);
        let b = order("b", "t", Side::Buy, 100, 1, TS);
        let a = order("a", "t", Side::Buy, 100, 1, TS);

        assert_eq!(sequencer.push(b.clone()), SequenceOutcome::Queued);
        assert!(sequencer.drain_ready(TS + 50).is_empty());

        assert_eq!(sequencer.push(a), SequenceOutcome::Queued);
        let released: Vec<_> = sequencer
            .drain_ready(TS + 100)
            .into_iter()
            .map(|o| o.id)
            .collect();
        assert_eq!(released, ["a", "b"]);
        assert!(sequencer.is_empty());

        // A duplicate gossip of the same order is ignored.
        sequencer.push(b.clone());
        assert_eq!(sequencer.push(b), SequenceOutcome::Duplicate);
        assert_eq!(sequencer.len(), 1);
    }

    #[test]
    fn test_sequencer_flags_late_collisions() {
        let mut sequencer = MatchSequencer::new(0);
        sequencer.push(order("b", "t", Side::Buy, 100, 1, TS));
        sequencer.drain_ready(TS);

        // Same timestamp but lower ID than an already released order.
        let late = order("a", "t", Side::Buy, 100, 1, TS);
        assert_eq!(sequencer.push(late), SequenceOutcome::Late);
        assert_eq!(sequencer.drain_all().len(), 1);
    }
}
