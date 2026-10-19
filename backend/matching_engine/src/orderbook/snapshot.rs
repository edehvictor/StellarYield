//! # Order book recovery snapshots
//!
//! A snapshot captures the full state of an [`OrderBook`] at an event
//! sequence number, together with a SHA-256 checksum over that state.
//! Recovery validates the checksum *before* replaying any subsequent events,
//! so a corrupted or tampered snapshot is rejected instead of being used as
//! the base for a diverging book.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::{Order, OrderBook, OrderBookError, OrderStatus};
use crate::network::tie_break::sort_canonical;

/// Domain separator mixed into every snapshot checksum
const CHECKSUM_DOMAIN: &[u8] = b"stellaryield-orderbook-snapshot-v1";

/// Errors raised while validating or recovering from a snapshot
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SnapshotError {
    #[error("snapshot checksum mismatch: expected {expected}, computed {computed}")]
    ChecksumMismatch { expected: String, computed: String },
    #[error("snapshot state could not be encoded: {0}")]
    Encoding(String),
    #[error("expected event sequence {expected}, found {found}")]
    SequenceGap { expected: u64, found: u64 },
    #[error("order {0} already exists")]
    DuplicateOrder(String),
    #[error("order {0} not found")]
    UnknownOrder(String),
    #[error("order book rejected the change: {0}")]
    Book(#[from] OrderBookError),
}

/// An order book mutation recorded after a snapshot
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BookEvent {
    /// A resting order was added to the book
    OrderAdded(Order),
    /// An order was removed (cancelled, expired or fully filled)
    OrderRemoved { order_id: String },
    /// An order's cumulative filled amount changed
    OrderFilled { order_id: String, filled: u128 },
}

/// A [`BookEvent`] tagged with its position in the event log
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedEvent {
    pub sequence: u64,
    pub event: BookEvent,
}

/// Checksummed, serialisable order book state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookSnapshot {
    pub pair_id: String,
    pub token0: String,
    pub token1: String,
    /// Sequence number of the last event included in this snapshot
    pub sequence: u64,
    /// Resting orders, in canonical (timestamp, id) order
    pub orders: Vec<Order>,
    /// Hex-encoded SHA-256 over the fields above
    pub checksum: String,
}

/// The checksummed portion of a snapshot, borrowed for encoding
#[derive(Serialize)]
struct SnapshotState<'a> {
    pair_id: &'a str,
    token0: &'a str,
    token1: &'a str,
    sequence: u64,
    orders: &'a [Order],
}

impl OrderBookSnapshot {
    /// Capture the state of `book` as of event `sequence`
    pub fn capture(book: &OrderBook, sequence: u64) -> Result<Self, SnapshotError> {
        let mut orders: Vec<Order> = book.orders.values().cloned().collect();
        // HashMap iteration order is random; sort so equal books hash equally.
        sort_canonical(&mut orders);

        let mut snapshot = Self {
            pair_id: book.pair_id.clone(),
            token0: book.token0.clone(),
            token1: book.token1.clone(),
            sequence,
            orders,
            checksum: String::new(),
        };
        snapshot.checksum = snapshot.compute_checksum()?;
        Ok(snapshot)
    }

    /// Recompute the checksum over the snapshot's current contents
    pub fn compute_checksum(&self) -> Result<String, SnapshotError> {
        let state = SnapshotState {
            pair_id: &self.pair_id,
            token0: &self.token0,
            token1: &self.token1,
            sequence: self.sequence,
            orders: &self.orders,
        };
        let encoded =
            serde_json::to_vec(&state).map_err(|e| SnapshotError::Encoding(e.to_string()))?;

        let mut hasher = Sha256::new();
        hasher.update(CHECKSUM_DOMAIN);
        hasher.update(&encoded);
        Ok(hex::encode(hasher.finalize()))
    }

    /// Check that the stored checksum matches the snapshot contents
    pub fn verify(&self) -> Result<(), SnapshotError> {
        let computed = self.compute_checksum()?;
        if computed != self.checksum {
            return Err(SnapshotError::ChecksumMismatch {
                expected: self.checksum.clone(),
                computed,
            });
        }
        Ok(())
    }

    /// Rebuild the order book from a verified snapshot
    pub fn restore(&self) -> Result<OrderBook, SnapshotError> {
        self.verify()?;
        let mut book = OrderBook::new(
            self.pair_id.clone(),
            self.token0.clone(),
            self.token1.clone(),
        );
        for order in &self.orders {
            book.add_order(order.clone())?;
        }
        book.sequence = self.sequence;
        Ok(book)
    }

    /// Restore the snapshot and replay the events recorded after it.
    ///
    /// The checksum is validated before any event is applied. Events at or
    /// before `self.sequence` are already part of the snapshot and skipped;
    /// the rest must follow on contiguously.
    pub fn recover(&self, events: &[SequencedEvent]) -> Result<OrderBook, SnapshotError> {
        let mut book = self.restore()?;
        let mut expected = self.sequence + 1;

        for event in events.iter().filter(|e| e.sequence > self.sequence) {
            if event.sequence != expected {
                return Err(SnapshotError::SequenceGap {
                    expected,
                    found: event.sequence,
                });
            }
            book.apply_event(&event.event)?;
            // Keep the replayed events so clients can still be caught up from
            // the recovered book, and carry on numbering after the last one.
            book.sequence = event.sequence;
            book.journal.push(event.clone());
            expected += 1;
        }
        Ok(book)
    }
}

impl OrderBook {
    /// Capture a checksummed snapshot of this book as of event `sequence`
    pub fn snapshot(&self, sequence: u64) -> Result<OrderBookSnapshot, SnapshotError> {
        OrderBookSnapshot::capture(self, sequence)
    }

    /// Snapshot the book as of its latest event and drop the events the
    /// snapshot now covers. Recover from it with the events recorded later.
    pub fn checkpoint(&mut self) -> Result<OrderBookSnapshot, SnapshotError> {
        let snapshot = self.snapshot(self.sequence)?;
        self.trim_journal(snapshot.sequence);
        Ok(snapshot)
    }

    /// Apply a single recorded mutation
    pub fn apply_event(&mut self, event: &BookEvent) -> Result<(), SnapshotError> {
        match event {
            BookEvent::OrderAdded(order) => {
                if self.orders.contains_key(&order.id) {
                    return Err(SnapshotError::DuplicateOrder(order.id.clone()));
                }
                self.add_order(order.clone())?;
            }
            BookEvent::OrderRemoved { order_id } => {
                self.remove_order(order_id)
                    .ok_or_else(|| SnapshotError::UnknownOrder(order_id.clone()))?;
            }
            BookEvent::OrderFilled { order_id, filled } => {
                let mut order = self
                    .remove_order(order_id)
                    .ok_or_else(|| SnapshotError::UnknownOrder(order_id.clone()))?;
                if *filled > order.amount {
                    // Put the order back untouched before reporting the bad event.
                    let (requested, remaining) = (*filled, order.amount);
                    self.add_order(order)?;
                    return Err(OrderBookError::Fill(super::FillError::ExceedsRemaining {
                        requested,
                        remaining,
                    })
                    .into());
                }
                order.filled = *filled;
                if order.remaining() == 0 {
                    order.status = OrderStatus::Filled;
                } else {
                    order.status = OrderStatus::PartiallyFilled;
                    // Re-adding keeps the order's queue position because
                    // levels are ordered by (timestamp, id), not arrival.
                    self.add_order(order)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orderbook::{OrderType, Side};

    fn order(id: &str, side: Side, price: u128, amount: u128, ts: u64) -> Order {
        let mut o = Order::new(
            "trader".to_string(),
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

    fn sample_book() -> OrderBook {
        let mut book = OrderBook::new(
            "token0-token1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );
        book.add_order(order("bid-1", Side::Buy, 99, 1_000, 10))
            .unwrap();
        book.add_order(order("bid-2", Side::Buy, 99, 500, 10))
            .unwrap();
        book.add_order(order("ask-1", Side::Sell, 101, 800, 11))
            .unwrap();
        book
    }

    /// (bids, asks, "id:filled" for every order)
    type BookSummary = (Vec<(u128, u128)>, Vec<(u128, u128)>, Vec<String>);

    fn summary(book: &OrderBook) -> BookSummary {
        let depth = book.depth(usize::MAX);
        let mut ids: Vec<String> = book
            .orders
            .values()
            .map(|o| format!("{}:{}", o.id, o.filled))
            .collect();
        ids.sort();
        (depth.bids, depth.asks, ids)
    }

    #[test]
    fn test_checksum_is_deterministic() {
        let a = sample_book().snapshot(7).unwrap();
        let b = sample_book().snapshot(7).unwrap();
        assert_eq!(a.checksum, b.checksum);
        assert_eq!(a.checksum.len(), 64);
        a.verify().unwrap();

        // The sequence number is part of the checksummed state.
        let c = sample_book().snapshot(8).unwrap();
        assert_ne!(a.checksum, c.checksum);
    }

    #[test]
    fn test_clean_restart_restores_identical_book() {
        let book = sample_book();
        let snapshot = book.snapshot(3).unwrap();

        // Round-trip through storage as a restarting node would.
        let encoded = serde_json::to_string(&snapshot).unwrap();
        let loaded: OrderBookSnapshot = serde_json::from_str(&encoded).unwrap();

        let restored = loaded.restore().unwrap();
        assert_eq!(summary(&restored), summary(&book));
        assert_eq!(
            restored.bids.levels[&99].orders,
            book.bids.levels[&99].orders
        );
    }

    #[test]
    fn test_clean_restart_replays_subsequent_events() {
        let mut live = sample_book();
        let snapshot = live.snapshot(3).unwrap();

        let events = vec![
            // Already included in the snapshot; must be skipped.
            SequencedEvent {
                sequence: 3,
                event: BookEvent::OrderAdded(order("ask-1", Side::Sell, 101, 800, 11)),
            },
            SequencedEvent {
                sequence: 4,
                event: BookEvent::OrderAdded(order("ask-2", Side::Sell, 102, 300, 12)),
            },
            SequencedEvent {
                sequence: 5,
                event: BookEvent::OrderFilled {
                    order_id: "bid-1".to_string(),
                    filled: 400,
                },
            },
            SequencedEvent {
                sequence: 6,
                event: BookEvent::OrderRemoved {
                    order_id: "bid-2".to_string(),
                },
            },
            SequencedEvent {
                sequence: 7,
                event: BookEvent::OrderFilled {
                    order_id: "ask-1".to_string(),
                    filled: 800,
                },
            },
        ];
        for e in events.iter().filter(|e| e.sequence > 3) {
            live.apply_event(&e.event).unwrap();
        }

        let recovered = snapshot.recover(&events).unwrap();
        assert_eq!(summary(&recovered), summary(&live));
        assert_eq!(recovered.depth(10).bids, vec![(99, 600)]);
        assert_eq!(recovered.depth(10).asks, vec![(102, 300)]);
        assert_eq!(
            recovered.snapshot(7).unwrap().checksum,
            live.snapshot(7).unwrap().checksum
        );
    }

    #[test]
    fn test_corrupted_snapshot_is_rejected_before_replay() {
        let mut snapshot = sample_book().snapshot(3).unwrap();
        // Simulate on-disk corruption of a resting order.
        snapshot.orders[0].amount += 1;

        let events = vec![SequencedEvent {
            sequence: 4,
            event: BookEvent::OrderAdded(order("ask-2", Side::Sell, 102, 300, 12)),
        }];

        assert!(matches!(
            snapshot.verify(),
            Err(SnapshotError::ChecksumMismatch { .. })
        ));
        assert!(matches!(
            snapshot.restore(),
            Err(SnapshotError::ChecksumMismatch { .. })
        ));
        assert!(matches!(
            snapshot.recover(&events),
            Err(SnapshotError::ChecksumMismatch { .. })
        ));
    }

    #[test]
    fn test_corrupted_serialized_snapshot_is_rejected() {
        let snapshot = sample_book().snapshot(3).unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        let tampered = encoded.replace("\"price\":101", "\"price\":1");
        assert_ne!(encoded, tampered);

        let loaded: OrderBookSnapshot = serde_json::from_str(&tampered).unwrap();
        assert!(matches!(
            loaded.recover(&[]),
            Err(SnapshotError::ChecksumMismatch { .. })
        ));

        // A forged checksum field is caught too.
        let mut forged = snapshot.clone();
        forged.checksum = "00".repeat(32);
        assert!(forged.verify().is_err());
    }

    #[test]
    fn test_replay_rejects_sequence_gap() {
        let snapshot = sample_book().snapshot(3).unwrap();
        let events = vec![SequencedEvent {
            sequence: 5,
            event: BookEvent::OrderRemoved {
                order_id: "bid-1".to_string(),
            },
        }];
        assert_eq!(
            snapshot.recover(&events).unwrap_err(),
            SnapshotError::SequenceGap {
                expected: 4,
                found: 5
            }
        );
    }

    #[test]
    fn test_replay_rejects_unknown_and_duplicate_orders() {
        let snapshot = sample_book().snapshot(0).unwrap();
        let unknown = vec![SequencedEvent {
            sequence: 1,
            event: BookEvent::OrderRemoved {
                order_id: "missing".to_string(),
            },
        }];
        assert_eq!(
            snapshot.recover(&unknown).unwrap_err(),
            SnapshotError::UnknownOrder("missing".to_string())
        );

        let duplicate = vec![SequencedEvent {
            sequence: 1,
            event: BookEvent::OrderAdded(order("bid-1", Side::Buy, 99, 1_000, 10)),
        }];
        assert_eq!(
            snapshot.recover(&duplicate).unwrap_err(),
            SnapshotError::DuplicateOrder("bid-1".to_string())
        );
    }
}
