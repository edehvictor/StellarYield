//! # Matching Engine Module
//!
//! Implements the core order matching algorithm with price-time priority.
//! Matches buy and sell orders and generates trade executions.

use crate::orderbook::{
    BookEvent, Order, OrderBook, OrderBookError, OrderBookSnapshot, OrderStatus, OrderType,
    SequencedEvent, Side, SnapshotError, Trade,
};

/// What the engine does when an incoming order would trade against a resting
/// order placed by the same trader.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SelfTradePolicy {
    /// Cancel what is left of the incoming order. Trades already made against
    /// other traders stand and the resting order is untouched.
    #[default]
    CancelNewest,
    /// Cancel the resting order and carry on matching the incoming order.
    CancelOldest,
    /// Cancel the resting order and what is left of the incoming order.
    CancelBoth,
    /// Refuse the incoming order before anything trades if any part of it
    /// would meet one of the trader's own resting orders.
    RejectIncoming,
}

/// Acknowledgment of an order operation.
///
/// `sequence` is the market's sequence number once the operation has been
/// applied. Every event the operation produced has a sequence number no
/// greater than it, so a client that has applied all events up to `sequence`
/// is in step with the book.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderAck {
    pub order_id: String,
    pub pair_id: String,
    pub sequence: u64,
    /// State of the order after the operation
    pub status: OrderStatus,
}

/// Matching engine result
#[derive(Debug, Clone)]
pub struct MatchResult {
    /// Trades executed
    pub trades: Vec<Trade>,
    /// Updated taker order
    pub remaining_order: Option<Order>,
    /// Orders that were fully filled
    pub filled_orders: Vec<String>,
    /// Set when matching stopped early because a fill could not be applied
    /// safely (quantity overflow, a fill larger than the quantity left, or an
    /// order book whose totals disagree with its orders). Trades executed
    /// before the failure are still reported and the book is left consistent.
    pub error: Option<OrderBookError>,
    /// Orders cancelled to prevent a trade between orders of the same trader
    pub self_trade_cancelled: Vec<String>,
    /// Book events this submission caused, in sequence order
    pub events: Vec<SequencedEvent>,
    /// Acknowledgment carrying the market sequence number after this order
    pub ack: Option<OrderAck>,
}

impl MatchResult {
    pub fn new() -> Self {
        Self {
            trades: Vec::new(),
            remaining_order: None,
            filled_orders: Vec::new(),
            error: None,
            self_trade_cancelled: Vec::new(),
            events: Vec::new(),
            ack: None,
        }
    }
}

impl Default for MatchResult {
    fn default() -> Self {
        Self::new()
    }
}

/// The matching engine
pub struct MatchingEngine {
    /// Order books by pair ID
    order_books: std::collections::HashMap<String, OrderBook>,
    self_trade_policy: SelfTradePolicy,
}

impl MatchingEngine {
    pub fn new() -> Self {
        Self::with_self_trade_policy(SelfTradePolicy::default())
    }

    /// Create an engine that handles self-trades with `policy`
    pub fn with_self_trade_policy(policy: SelfTradePolicy) -> Self {
        Self {
            order_books: std::collections::HashMap::new(),
            self_trade_policy: policy,
        }
    }

    pub fn self_trade_policy(&self) -> SelfTradePolicy {
        self.self_trade_policy
    }

    pub fn set_self_trade_policy(&mut self, policy: SelfTradePolicy) {
        self.self_trade_policy = policy;
    }

    /// Sequence number of the last event of `pair_id`'s market
    pub fn sequence(&self, pair_id: &str) -> Option<u64> {
        self.get_book(pair_id).map(OrderBook::sequence)
    }

    /// Snapshot a market at its current sequence and trim the events the
    /// snapshot covers.
    pub fn checkpoint(&mut self, pair_id: &str) -> Result<OrderBookSnapshot, SnapshotError> {
        self.get_book_mut(pair_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(pair_id.to_string()))?
            .checkpoint()
    }

    /// Rebuild a market after a restart from its last snapshot and the events
    /// recorded after it. Sequence numbers carry on from the last replayed
    /// event, so none is ever handed out twice.
    pub fn recover_book(
        &mut self,
        snapshot: &OrderBookSnapshot,
        events: &[SequencedEvent],
    ) -> Result<(), SnapshotError> {
        let book = snapshot.recover(events)?;
        self.order_books.insert(book.pair_id.clone(), book);
        Ok(())
    }

    /// Get or create order book for a pair
    pub fn get_or_create_book(
        &mut self,
        pair_id: String,
        token0: String,
        token1: String,
    ) -> &mut OrderBook {
        use std::collections::hash_map::Entry;
        match self.order_books.entry(pair_id.clone()) {
            Entry::Vacant(entry) => entry.insert(OrderBook::new(pair_id, token0, token1)),
            Entry::Occupied(entry) => entry.into_mut(),
        }
    }

    /// Get order book for a pair
    pub fn get_book(&self, pair_id: &str) -> Option<&OrderBook> {
        self.order_books.get(pair_id)
    }

    /// Get mutable order book for a pair
    pub fn get_book_mut(&mut self, pair_id: &str) -> Option<&mut OrderBook> {
        self.order_books.get_mut(pair_id)
    }

    /// Submit a new order and attempt to match
    pub fn submit_order(&mut self, mut order: Order) -> MatchResult {
        let pair_id = format!("{}-{}", order.token0, order.token1);

        // Ensure the order book exists before matching
        self.get_or_create_book(pair_id.clone(), order.token0.clone(), order.token1.clone());

        // Refuse the order up front when the policy says a self-trade must not
        // even start; nothing is traded or recorded.
        let refusal = if self.self_trade_policy == SelfTradePolicy::RejectIncoming {
            self.reject_if_self_trade(&pair_id, &order)
        } else {
            None
        };
        let mut result = match refusal {
            Some(refusal) => {
                order.status = OrderStatus::Cancelled;
                refusal
            }
            None => self.match_order(&mut order),
        };

        // If there's remaining amount, add to order book. An order cancelled to
        // prevent a self-trade never rests.
        if order.remaining() > 0
            && order.order_type == OrderType::Limit
            && order.status != OrderStatus::Cancelled
        {
            if let Some(book) = self.get_book_mut(&pair_id) {
                order.status = if order.filled > 0 {
                    OrderStatus::PartiallyFilled
                } else {
                    OrderStatus::Pending
                };
                match book.add_order(order.clone()) {
                    Ok(()) => {
                        let event = book.record(BookEvent::OrderAdded(order.clone()));
                        result.events.push(event);
                    }
                    Err(error) => {
                        result.error.get_or_insert(error);
                    }
                }
            }
        } else if order.remaining() == 0 {
            order.status = OrderStatus::Filled;
        }

        result.ack = Some(OrderAck {
            order_id: order.id.clone(),
            sequence: self.sequence(&pair_id).unwrap_or(0),
            pair_id,
            status: order.status,
        });
        result.remaining_order = if order.remaining() > 0 && order.status != OrderStatus::Cancelled
        {
            Some(order)
        } else {
            None
        };
        result
    }

    /// Under [`SelfTradePolicy::RejectIncoming`], a result refusing `order` if
    /// it would meet one of its own trader's resting orders.
    fn reject_if_self_trade(&mut self, pair_id: &str, order: &Order) -> Option<MatchResult> {
        let book = self.get_book(pair_id)?;
        let resting_order_id = book.find_self_match(order)?.to_string();
        let mut result = MatchResult::new();
        result.error = Some(OrderBookError::SelfTrade {
            trader: order.trader.clone(),
            resting_order_id,
        });
        Some(result)
    }

    /// Match an order against the order book
    fn match_order(&mut self, order: &mut Order) -> MatchResult {
        let pair_id = format!("{}-{}", order.token0, order.token1);
        let mut result = MatchResult::new();
        let policy = self.self_trade_policy;

        let book = match self.get_book_mut(&pair_id) {
            Some(b) => b,
            None => return result, // No order book yet
        };

        while order.remaining() > 0 {
            // Best resting price and the order at the front of its queue, on
            // the side opposite to the incoming order.
            let (best_price, maker_order_id) = match order.side {
                Side::Buy => (book.best_ask(), book.asks.best_orders()),
                Side::Sell => (book.best_bid(), book.bids.best_orders()),
            };
            let best_price = match best_price {
                Some(price) => price,
                None => break, // Nothing left to match against
            };

            // For limit orders, check the price crosses
            if order.order_type == OrderType::Limit {
                let crosses = match order.side {
                    Side::Buy => order.price >= best_price,
                    Side::Sell => order.price <= best_price,
                };
                if !crosses {
                    break;
                }
            }

            let maker_order_id = match maker_order_id.and_then(|queue| queue.front()) {
                Some(id) => id.clone(),
                None => break,
            };
            let (maker_remaining, match_price) = match book.get_order(&maker_order_id) {
                Some(maker) => (maker.remaining(), maker.price), // Price-time priority: maker's price
                None => break,
            };

            // The incoming order meets one of its own trader's resting orders.
            if book
                .get_order(&maker_order_id)
                .is_some_and(|maker| maker.trader == order.trader)
            {
                let cancel_resting = matches!(
                    policy,
                    SelfTradePolicy::CancelOldest | SelfTradePolicy::CancelBoth
                );
                let cancel_incoming = !matches!(policy, SelfTradePolicy::CancelOldest);
                if cancel_resting {
                    book.remove_order(&maker_order_id);
                    let event = book.record(BookEvent::OrderRemoved {
                        order_id: maker_order_id.clone(),
                    });
                    result.events.push(event);
                    result.self_trade_cancelled.push(maker_order_id);
                }
                if cancel_incoming {
                    order.status = OrderStatus::Cancelled;
                    result.self_trade_cancelled.push(order.id.clone());
                    break;
                }
                continue;
            }

            // A resting order with nothing left to fill should not be in the
            // book; drop it rather than producing a zero-quantity trade.
            if maker_remaining == 0 {
                book.remove_order(&maker_order_id);
                continue;
            }

            let match_amount = order.remaining().min(maker_remaining);

            // Validate both fills before changing anything so a failure cannot
            // leave the maker filled and the taker not (or the reverse).
            let taker_filled = match order.checked_filled_after(match_amount) {
                Ok(filled) => filled,
                Err(error) => {
                    result.error = Some(error.into());
                    break;
                }
            };
            let (trade, maker_filled_after) = match book.get_order(&maker_order_id) {
                Some(maker) => (
                    Trade::new(maker, order, match_amount, match_price),
                    maker.filled.saturating_add(match_amount),
                ),
                None => break,
            };
            match book.fill_order(&maker_order_id, match_amount) {
                Ok(maker_filled) => {
                    let event = book.record(BookEvent::OrderFilled {
                        order_id: maker_order_id.clone(),
                        filled: maker_filled_after,
                    });
                    result.events.push(event);
                    if maker_filled {
                        result.filled_orders.push(maker_order_id);
                    }
                }
                Err(error) => {
                    result.error = Some(error);
                    break;
                }
            }
            order.filled = taker_filled;
            result.trades.push(trade);
        }

        result
    }

    /// Cancel an order, but only if it is still at `expected_version`.
    ///
    /// Use this for cancels that may arrive late: if the order was replaced in
    /// the meantime the cancel is rejected with
    /// [`OrderBookError::StaleVersion`] and the newer order is untouched.
    pub fn cancel_order_versioned(
        &mut self,
        pair_id: &str,
        order_id: &str,
        expected_version: u64,
    ) -> Result<Order, OrderBookError> {
        self.cancel_order_acked(pair_id, order_id, Some(expected_version))
            .map(|(order, _)| order)
    }

    /// Replace a resting order (same ID, next version) with `replacement`,
    /// matching the replacement against the book as a new order.
    ///
    /// The request must carry the order's current version and come from its
    /// trader. The replacement does not keep the old order's time priority.
    /// Returns the replaced order and the result of matching the replacement.
    pub fn replace_order(
        &mut self,
        pair_id: &str,
        order_id: &str,
        expected_version: u64,
        mut replacement: Order,
    ) -> Result<(Order, MatchResult), OrderBookError> {
        let book = self
            .get_book_mut(pair_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?;
        let (old, next_version) =
            book.detach_for_replacement(order_id, expected_version, &replacement.trader)?;
        let removal = book.record(BookEvent::OrderRemoved {
            order_id: order_id.to_string(),
        });
        replacement.id = order_id.to_string();
        replacement.version = next_version;
        replacement.filled = 0;
        replacement.status = OrderStatus::Pending;
        replacement.token0 = old.token0.clone();
        replacement.token1 = old.token1.clone();
        let mut result = self.submit_order(replacement);
        result.events.insert(0, removal);
        Ok((old, result))
    }

    /// Cancel an order
    pub fn cancel_order(&mut self, pair_id: &str, order_id: &str) -> Option<Order> {
        self.cancel_order_acked(pair_id, order_id, None)
            .ok()
            .map(|(order, _)| order)
    }

    /// Cancel an order and acknowledge it with the market's new sequence
    /// number. With `expected_version` the cancel is only applied if the order
    /// is still at that version (see [`Self::cancel_order_versioned`]).
    pub fn cancel_order_acked(
        &mut self,
        pair_id: &str,
        order_id: &str,
        expected_version: Option<u64>,
    ) -> Result<(Order, OrderAck), OrderBookError> {
        let book = self
            .get_book_mut(pair_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?;
        let order = match expected_version {
            Some(version) => book.cancel_versioned(order_id, version)?,
            None => book
                .remove_order(order_id)
                .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?,
        };
        book.record(BookEvent::OrderRemoved {
            order_id: order_id.to_string(),
        });
        let ack = OrderAck {
            order_id: order_id.to_string(),
            pair_id: pair_id.to_string(),
            sequence: book.sequence(),
            status: OrderStatus::Cancelled,
        };
        Ok((order, ack))
    }

    /// Get all trades for a user
    pub fn get_user_trades(&self, _user: &str, _pair_id: &str) -> Vec<&Trade> {
        // This would require storing trade history
        // For now, return empty vector
        Vec::new()
    }

    /// Get order book depth
    pub fn get_depth(
        &self,
        pair_id: &str,
        levels: usize,
    ) -> Option<crate::orderbook::OrderBookDepth> {
        self.get_book(pair_id).map(|book| book.depth(levels))
    }
}

impl Default for MatchingEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orderbook::FillError;

    /// Buys and sells come from different traders so they can trade.
    fn create_test_order(side: Side, price: u128, amount: u128) -> Order {
        Order::new(
            match side {
                Side::Buy => "test_buyer",
                Side::Sell => "test_seller",
            }
            .to_string(),
            side,
            OrderType::Limit,
            price,
            amount,
            "token0".to_string(),
            "token1".to_string(),
            "signature".to_string(),
        )
    }

    #[test]
    fn test_matching_engine_creation() {
        let engine = MatchingEngine::new();
        assert!(engine.order_books.is_empty());
    }

    #[test]
    fn test_submit_buy_order_no_match() {
        let mut engine = MatchingEngine::new();
        let order = create_test_order(Side::Buy, 100, 1000);

        let result = engine.submit_order(order);

        // Should have remaining order added to book
        assert!(result.remaining_order.is_some());
        assert_eq!(result.trades.len(), 0);
    }

    #[test]
    fn test_submit_sell_order_no_match() {
        let mut engine = MatchingEngine::new();
        let order = create_test_order(Side::Sell, 100, 1000);

        let result = engine.submit_order(order);

        assert!(result.remaining_order.is_some());
        assert_eq!(result.trades.len(), 0);
    }

    #[test]
    fn test_simple_match() {
        let mut engine = MatchingEngine::new();

        // Add sell order at 100
        let sell_order = create_test_order(Side::Sell, 100, 1000);
        engine.submit_order(sell_order);

        // Add buy order at 100 (should match)
        let buy_order = create_test_order(Side::Buy, 100, 500);
        let result = engine.submit_order(buy_order);

        // Should have executed a trade
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].price, 100);
        assert_eq!(result.trades[0].amount, 500);
    }

    #[test]
    fn test_price_time_priority() {
        let mut engine = MatchingEngine::new();

        // Add multiple sell orders at different prices
        engine.submit_order(create_test_order(Side::Sell, 105, 1000));
        engine.submit_order(create_test_order(Side::Sell, 100, 1000)); // Best price
        engine.submit_order(create_test_order(Side::Sell, 103, 1000));

        // Add buy order that should match at best price
        let buy_order = create_test_order(Side::Buy, 110, 500);
        let result = engine.submit_order(buy_order);

        // Should match at 100 (best price)
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].price, 100);
    }

    #[test]
    fn test_partial_fill() {
        let mut engine = MatchingEngine::new();

        // Add small sell order
        engine.submit_order(create_test_order(Side::Sell, 100, 500));

        // Add larger buy order
        let buy_order = create_test_order(Side::Buy, 100, 1000);
        let result = engine.submit_order(buy_order);

        // Should partially fill
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].amount, 500);
        assert!(result.remaining_order.is_some());
        assert_eq!(result.remaining_order.as_ref().unwrap().remaining(), 500);
    }

    #[test]
    fn test_limit_order_price_check() {
        let mut engine = MatchingEngine::new();

        // Add sell order at 100
        engine.submit_order(create_test_order(Side::Sell, 100, 1000));

        // Add buy order at 90 (shouldn't match)
        let buy_order = create_test_order(Side::Buy, 90, 1000);
        let result = engine.submit_order(buy_order);

        // Should not match due to price
        assert_eq!(result.trades.len(), 0);
        assert!(result.remaining_order.is_some());
    }

    // ── Checked fill quantities (#1520) ──────────────────────────────────────

    fn order_at(side: Side, price: u128, amount: u128, timestamp: u64, trader: &str) -> Order {
        let mut order = Order::new(
            trader.to_string(),
            side,
            OrderType::Limit,
            price,
            amount,
            "token0".to_string(),
            "token1".to_string(),
            "signature".to_string(),
        );
        order.timestamp = timestamp;
        order
    }

    const PAIR: &str = "token0-token1";

    #[test]
    fn test_full_fill_at_the_maximum_quantity() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 1, u128::MAX, 1, "maker"));

        let result = engine.submit_order(order_at(Side::Buy, 1, u128::MAX, 2, "taker"));

        assert!(result.error.is_none());
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].amount, u128::MAX);
        assert!(result.remaining_order.is_none());
        let book = engine.get_book(PAIR).unwrap();
        assert!(book.orders.is_empty());
        assert_eq!(book.best_ask(), None);
    }

    #[test]
    fn test_repeated_partial_fills_add_up_exactly() {
        let mut engine = MatchingEngine::new();
        let maker = order_at(Side::Sell, 10, 1_000, 1, "maker");
        let maker_id = maker.id.clone();
        engine.submit_order(maker);

        for i in 0..99u64 {
            let result = engine.submit_order(order_at(Side::Buy, 10, 10, 2 + i, "taker"));
            assert!(result.error.is_none());
            assert_eq!(result.trades.len(), 1);
            assert_eq!(result.trades[0].amount, 10);
        }

        let book = engine.get_book(PAIR).unwrap();
        let maker = book.get_order(&maker_id).unwrap();
        assert_eq!(maker.filled, 990);
        assert_eq!(maker.remaining(), 10);
        assert_eq!(maker.status, OrderStatus::PartiallyFilled);

        // The last fill completes the order and removes it and its price level.
        let result = engine.submit_order(order_at(Side::Buy, 10, 10, 200, "taker"));
        assert_eq!(result.filled_orders, vec![maker_id.clone()]);
        let book = engine.get_book(PAIR).unwrap();
        assert!(book.get_order(&maker_id).is_none());
        assert_eq!(book.best_ask(), None);
        assert!(book.asks.levels.is_empty());
    }

    #[test]
    fn test_partial_fills_near_the_limit_never_overflow() {
        let mut engine = MatchingEngine::new();
        let maker = order_at(Side::Sell, 1, u128::MAX, 1, "maker");
        let maker_id = maker.id.clone();
        engine.submit_order(maker);

        let third = u128::MAX / 4; // 3 * third leaves a remainder of third + 3
        for i in 0..3u64 {
            let result = engine.submit_order(order_at(Side::Buy, 1, third, 2 + i, "taker"));
            assert!(result.error.is_none());
            assert_eq!(result.trades[0].amount, third);
        }

        let maker = engine.get_book(PAIR).unwrap().get_order(&maker_id).unwrap();
        assert_eq!(maker.filled, third * 3);
        assert_eq!(maker.remaining(), u128::MAX - third * 3);

        // A taker larger than what is left only fills what is left.
        let result = engine.submit_order(order_at(Side::Buy, 1, u128::MAX, 10, "taker"));
        assert!(result.error.is_none());
        assert_eq!(result.trades[0].amount, u128::MAX - third * 3);
        assert_eq!(result.filled_orders, vec![maker_id]);
        assert_eq!(
            result.remaining_order.unwrap().remaining(),
            u128::MAX - (u128::MAX - third * 3)
        );
    }

    #[test]
    fn test_price_level_total_tracks_partial_fills() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 600, 1, "a"));
        engine.submit_order(order_at(Side::Sell, 100, 400, 2, "b"));
        assert_eq!(engine.get_depth(PAIR, 5).unwrap().asks, vec![(100, 1_000)]);

        engine.submit_order(order_at(Side::Buy, 100, 250, 3, "taker"));
        assert_eq!(engine.get_depth(PAIR, 5).unwrap().asks, vec![(100, 750)]);

        engine.submit_order(order_at(Side::Buy, 100, 750, 4, "taker"));
        let book = engine.get_book(PAIR).unwrap();
        assert!(
            book.asks.levels.is_empty(),
            "no phantom price level is left behind"
        );
        assert_eq!(book.best_ask(), None);
    }

    #[test]
    fn test_corrupt_overfilled_maker_is_dropped_without_a_trade() {
        let mut engine = MatchingEngine::new();
        let maker = order_at(Side::Sell, 100, 50, 1, "maker");
        let maker_id = maker.id.clone();
        engine.submit_order(maker);
        // Simulate corrupted state: more filled than the order amount.
        engine
            .get_book_mut(PAIR)
            .unwrap()
            .get_order_mut(&maker_id)
            .unwrap()
            .filled = 80;

        let result = engine.submit_order(order_at(Side::Buy, 100, 10, 2, "taker"));

        assert!(
            result.trades.is_empty(),
            "no zero-quantity trade is produced"
        );
        assert!(result.error.is_none());
        assert!(engine
            .get_book(PAIR)
            .unwrap()
            .get_order(&maker_id)
            .is_none());
        assert_eq!(result.remaining_order.unwrap().remaining(), 10);
    }

    #[test]
    fn test_order_fill_rejects_more_than_remaining() {
        let mut order = order_at(Side::Buy, 1, 100, 1, "t");
        assert_eq!(
            order.apply_fill(101),
            Err(FillError::ExceedsRemaining {
                requested: 101,
                remaining: 100
            })
        );
        assert_eq!(order.filled, 0, "a rejected fill changes nothing");

        order.apply_fill(60).unwrap();
        assert_eq!(order.status, OrderStatus::PartiallyFilled);
        assert!(order.apply_fill(41).is_err());
        order.apply_fill(40).unwrap();
        assert_eq!(order.status, OrderStatus::Filled);
        assert_eq!(order.remaining(), 0);
        assert!(order.apply_fill(1).is_err());
    }

    #[test]
    fn test_order_fill_on_a_corrupt_order_is_rejected() {
        let mut order = order_at(Side::Buy, 1, 10, 1, "t");
        order.filled = 25;
        assert_eq!(
            order.checked_filled_after(1),
            Err(FillError::ExceedsRemaining {
                requested: 1,
                remaining: 0
            })
        );
    }

    #[test]
    fn test_book_fill_is_atomic_when_rejected() {
        let mut engine = MatchingEngine::new();
        let maker = order_at(Side::Sell, 100, 500, 1, "maker");
        let maker_id = maker.id.clone();
        engine.submit_order(maker);
        let book = engine.get_book_mut(PAIR).unwrap();

        let error = book.fill_order(&maker_id, 501).unwrap_err();
        assert!(matches!(
            error,
            OrderBookError::Fill(FillError::ExceedsRemaining { .. })
        ));
        assert_eq!(book.get_order(&maker_id).unwrap().filled, 0);
        assert_eq!(book.depth(1).asks, vec![(100, 500)]);
        assert_eq!(
            book.fill_order("missing", 1),
            Err(OrderBookError::OrderNotFound("missing".to_string()))
        );
    }

    #[test]
    fn test_price_level_overflow_is_rejected_not_saturated() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, u128::MAX, 1, "a"));

        let result = engine.submit_order(order_at(Side::Sell, 100, 1, 2, "b"));

        assert!(matches!(
            result.error,
            Some(OrderBookError::LevelOverflow { price: 100 })
        ));
        let book = engine.get_book(PAIR).unwrap();
        assert_eq!(book.orders.len(), 1, "the overflowing order was not added");
        assert_eq!(book.depth(1).asks, vec![(100, u128::MAX)]);
    }

    // ── Price-time priority after partial fills (#1517) ──────────────────────

    #[test]
    fn test_partially_filled_order_keeps_its_place_in_the_queue() {
        let mut engine = MatchingEngine::new();
        let first = order_at(Side::Sell, 100, 100, 1, "a");
        let second = order_at(Side::Sell, 100, 100, 2, "b");
        let third = order_at(Side::Sell, 100, 100, 3, "c");
        let (id1, id2, id3) = (first.id.clone(), second.id.clone(), third.id.clone());
        engine.submit_order(first);
        engine.submit_order(second);
        engine.submit_order(third);

        // 40 of the first order trades; it is now partially filled.
        let result = engine.submit_order(order_at(Side::Buy, 100, 40, 10, "t"));
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].maker_order_id, id1);

        // The next taker must still reach the first order before the later two.
        let result = engine.submit_order(order_at(Side::Buy, 100, 150, 11, "t"));
        let makers: Vec<(&str, u128)> = result
            .trades
            .iter()
            .map(|t| (t.maker_order_id.as_str(), t.amount))
            .collect();
        assert_eq!(
            makers,
            vec![(id1.as_str(), 60), (id2.as_str(), 90)],
            "first order's remaining 60, then the second order"
        );

        let book = engine.get_book(PAIR).unwrap();
        assert_eq!(book.get_order(&id2).unwrap().remaining(), 10);
        assert_eq!(book.get_order(&id3).unwrap().filled, 0);
        assert_eq!(book.asks.best_orders().unwrap().front(), Some(&id2));
    }

    #[test]
    fn test_priority_is_the_same_whether_or_not_orders_were_partially_filled() {
        // Three orders at one price, in order of arrival 1, 2, 3.
        let build = || {
            let mut engine = MatchingEngine::new();
            let orders: Vec<Order> = (1..=3)
                .map(|i| order_at(Side::Buy, 50, 100, i, &format!("t{i}")))
                .collect();
            let ids: Vec<String> = orders.iter().map(|o| o.id.clone()).collect();
            for order in orders {
                engine.submit_order(order);
            }
            (engine, ids)
        };

        let (mut plain, plain_ids) = build();
        let (mut partial, partial_ids) = build();

        // Partially fill the *middle* order's neighbour (the first) in one engine only.
        partial.submit_order(order_at(Side::Sell, 50, 30, 9, "s"));

        let sweep = |engine: &mut MatchingEngine, ids: &[String]| -> Vec<usize> {
            let result = engine.submit_order(order_at(Side::Sell, 50, 300, 20, "s"));
            result
                .trades
                .iter()
                .map(|t| ids.iter().position(|id| *id == t.maker_order_id).unwrap())
                .collect()
        };
        assert_eq!(sweep(&mut plain, &plain_ids), vec![0, 1, 2]);
        assert_eq!(sweep(&mut partial, &partial_ids), vec![0, 1, 2]);
    }

    #[test]
    fn test_partially_filled_order_keeps_priority_after_snapshot_restore() {
        let mut engine = MatchingEngine::new();
        let first = order_at(Side::Sell, 100, 100, 1, "a");
        let second = order_at(Side::Sell, 100, 100, 2, "b");
        let id1 = first.id.clone();
        engine.submit_order(first);
        engine.submit_order(second);
        engine.submit_order(order_at(Side::Buy, 100, 25, 5, "t"));

        let snapshot = engine.get_book(PAIR).unwrap().snapshot(7).unwrap();
        let restored = snapshot.restore().unwrap();

        assert_eq!(restored.asks.best_orders().unwrap().front(), Some(&id1));
        assert_eq!(restored.get_order(&id1).unwrap().filled, 25);
        assert_eq!(restored.depth(1).asks, vec![(100, 175)]);
    }

    // ── Versioned cancel and replace (#1518) ─────────────────────────────────

    #[test]
    fn test_stale_cancel_after_replacement_is_rejected() {
        let mut engine = MatchingEngine::new();
        let original = order_at(Side::Buy, 90, 100, 1, "alice");
        let order_id = original.id.clone();
        engine.submit_order(original);

        // The order is replaced (version 0 -> 1) at a better price.
        let (old, result) = engine
            .replace_order(PAIR, &order_id, 0, order_at(Side::Buy, 95, 80, 2, "alice"))
            .unwrap();
        assert_eq!(old.price, 90);
        assert!(result.trades.is_empty());

        // A delayed cancel that was meant for version 0 arrives now.
        let error = engine
            .cancel_order_versioned(PAIR, &order_id, 0)
            .unwrap_err();
        assert_eq!(
            error,
            OrderBookError::StaleVersion {
                order_id: order_id.clone(),
                requested: 0,
                current: 1
            }
        );

        // The replacement is untouched.
        let book = engine.get_book(PAIR).unwrap();
        let resting = book.get_order(&order_id).unwrap();
        assert_eq!(
            (resting.version, resting.price, resting.amount),
            (1, 95, 80)
        );
        assert_eq!(book.best_bid(), Some(95));

        // A cancel for the current version works, and cannot be repeated.
        assert_eq!(
            engine
                .cancel_order_versioned(PAIR, &order_id, 1)
                .unwrap()
                .id,
            order_id
        );
        assert_eq!(
            engine
                .cancel_order_versioned(PAIR, &order_id, 1)
                .unwrap_err(),
            OrderBookError::OrderNotFound(order_id)
        );
    }

    #[test]
    fn test_versions_increase_with_each_replacement() {
        let mut engine = MatchingEngine::new();
        let original = order_at(Side::Sell, 120, 10, 1, "alice");
        let order_id = original.id.clone();
        engine.submit_order(original);

        for expected_version in 0..3u64 {
            engine
                .replace_order(
                    PAIR,
                    &order_id,
                    expected_version,
                    order_at(Side::Sell, 120, 10, 2, "alice"),
                )
                .unwrap();
        }
        assert_eq!(
            engine
                .get_book(PAIR)
                .unwrap()
                .get_order(&order_id)
                .unwrap()
                .version,
            3
        );

        // Replacing from an outdated version is refused too.
        let error = engine
            .replace_order(
                PAIR,
                &order_id,
                1,
                order_at(Side::Sell, 121, 10, 3, "alice"),
            )
            .unwrap_err();
        assert!(matches!(
            error,
            OrderBookError::StaleVersion { current: 3, .. }
        ));
    }

    #[test]
    fn test_only_the_owner_can_replace_an_order() {
        let mut engine = MatchingEngine::new();
        let original = order_at(Side::Buy, 90, 100, 1, "alice");
        let order_id = original.id.clone();
        engine.submit_order(original);

        let error = engine
            .replace_order(
                PAIR,
                &order_id,
                0,
                order_at(Side::Buy, 99, 100, 2, "mallory"),
            )
            .unwrap_err();
        assert_eq!(error, OrderBookError::TraderMismatch(order_id.clone()));
        let resting = engine.get_book(PAIR).unwrap().get_order(&order_id).unwrap();
        assert_eq!(
            (resting.version, resting.price, resting.trader.as_str()),
            (0, 90, "alice")
        );
    }

    #[test]
    fn test_replacement_loses_time_priority_and_can_match_immediately() {
        let mut engine = MatchingEngine::new();
        let first = order_at(Side::Sell, 100, 50, 1, "a");
        let second = order_at(Side::Sell, 100, 50, 2, "b");
        let (id1, id2) = (first.id.clone(), second.id.clone());
        engine.submit_order(first);
        engine.submit_order(second);

        // Replacing the first order sends it to the back of the queue.
        engine
            .replace_order(PAIR, &id1, 0, order_at(Side::Sell, 100, 50, 3, "a"))
            .unwrap();
        let result = engine.submit_order(order_at(Side::Buy, 100, 50, 4, "t"));
        assert_eq!(result.trades[0].maker_order_id, id2);

        // A replacement that crosses the book trades straight away.
        let buy = order_at(Side::Buy, 80, 20, 5, "carol");
        let buy_id = buy.id.clone();
        engine.submit_order(buy);
        let (_, result) = engine
            .replace_order(PAIR, &buy_id, 0, order_at(Side::Buy, 100, 20, 6, "carol"))
            .unwrap();
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].maker_order_id, id1);
        assert_eq!(result.trades[0].amount, 20);
    }

    #[test]
    fn test_unversioned_cancel_still_works() {
        let mut engine = MatchingEngine::new();
        let order = order_at(Side::Buy, 90, 100, 1, "alice");
        let order_id = order.id.clone();
        engine.submit_order(order);
        assert!(engine.cancel_order(PAIR, &order_id).is_some());
        assert!(engine.cancel_order(PAIR, &order_id).is_none());
    }

    #[test]
    fn test_order_version_is_omitted_from_the_encoded_form_while_zero() {
        let mut order = order_at(Side::Buy, 1, 1, 1, "t");
        let json = serde_json::to_string(&order).unwrap();
        assert!(
            !json.contains("version"),
            "unchanged encoding keeps snapshot checksums valid"
        );

        order.version = 2;
        assert!(serde_json::to_string(&order)
            .unwrap()
            .contains("\"version\":2"));

        let decoded: Order = serde_json::from_str(&json).unwrap();
        assert_eq!(
            decoded.version, 0,
            "orders encoded before versions existed decode as 0"
        );
    }

    // ── Self-trade prevention (#1516) ────────────────────────────────────────

    fn engine_with(policy: SelfTradePolicy) -> MatchingEngine {
        MatchingEngine::with_self_trade_policy(policy)
    }

    fn resting_ids(engine: &MatchingEngine) -> Vec<String> {
        let mut ids: Vec<String> = engine
            .get_book(PAIR)
            .unwrap()
            .orders
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    #[test]
    fn test_default_policy_cancels_the_newest_order() {
        assert_eq!(
            MatchingEngine::new().self_trade_policy(),
            SelfTradePolicy::CancelNewest
        );
        let mut engine = MatchingEngine::new();
        let resting = order_at(Side::Sell, 100, 1_000, 1, "alice");
        let resting_id = resting.id.clone();
        engine.submit_order(resting);

        let incoming = order_at(Side::Buy, 100, 400, 2, "alice");
        let incoming_id = incoming.id.clone();
        let result = engine.submit_order(incoming);

        assert!(result.trades.is_empty());
        assert!(result.error.is_none());
        assert_eq!(result.self_trade_cancelled, vec![incoming_id.clone()]);
        assert!(result.remaining_order.is_none());
        assert_eq!(result.ack.as_ref().unwrap().status, OrderStatus::Cancelled);
        // The resting order is untouched and the incoming one never rested.
        assert_eq!(resting_ids(&engine), vec![resting_id]);
        assert_eq!(engine.get_book(PAIR).unwrap().best_bid(), None);
        assert_eq!(engine.get_depth(PAIR, 5).unwrap().asks, vec![(100, 1_000)]);
    }

    #[test]
    fn test_distinct_accounts_still_trade() {
        for policy in [
            SelfTradePolicy::CancelNewest,
            SelfTradePolicy::CancelOldest,
            SelfTradePolicy::CancelBoth,
            SelfTradePolicy::RejectIncoming,
        ] {
            let mut engine = engine_with(policy);
            engine.submit_order(order_at(Side::Sell, 100, 1_000, 1, "alice"));
            let result = engine.submit_order(order_at(Side::Buy, 100, 400, 2, "bob"));

            assert_eq!(result.trades.len(), 1, "{policy:?}");
            assert_eq!(result.trades[0].maker, "alice");
            assert_eq!(result.trades[0].taker, "bob");
            assert!(result.self_trade_cancelled.is_empty());
            assert!(result.error.is_none());
        }
    }

    #[test]
    fn test_trader_names_are_compared_exactly() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 1_000, 1, "alice"));
        let result = engine.submit_order(order_at(Side::Buy, 100, 400, 2, "Alice"));
        assert_eq!(result.trades.len(), 1);
    }

    #[test]
    fn test_orders_that_do_not_cross_are_not_a_self_trade() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 105, 1_000, 1, "alice"));
        let result = engine.submit_order(order_at(Side::Buy, 100, 400, 2, "alice"));

        assert!(result.trades.is_empty());
        assert!(result.self_trade_cancelled.is_empty());
        assert!(result.remaining_order.is_some());
        let book = engine.get_book(PAIR).unwrap();
        assert_eq!((book.best_bid(), book.best_ask()), (Some(100), Some(105)));
    }

    #[test]
    fn test_cancel_newest_keeps_trades_made_before_the_own_order() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 10, 1, "bob"));
        let own = order_at(Side::Sell, 101, 50, 2, "alice");
        let own_id = own.id.clone();
        engine.submit_order(own);

        let incoming = order_at(Side::Buy, 101, 30, 3, "alice");
        let incoming_id = incoming.id.clone();
        let result = engine.submit_order(incoming);

        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].maker, "bob");
        assert_eq!(result.trades[0].amount, 10);
        assert_eq!(result.self_trade_cancelled, vec![incoming_id]);
        assert!(result.remaining_order.is_none());
        assert_eq!(resting_ids(&engine), vec![own_id]);
    }

    #[test]
    fn test_sell_side_taker_is_covered_too() {
        let mut engine = MatchingEngine::new();
        let own = order_at(Side::Buy, 100, 500, 1, "alice");
        let own_id = own.id.clone();
        engine.submit_order(own);

        let result = engine.submit_order(order_at(Side::Sell, 90, 200, 2, "alice"));

        assert!(result.trades.is_empty());
        assert_eq!(result.self_trade_cancelled.len(), 1);
        assert_eq!(resting_ids(&engine), vec![own_id]);
    }

    #[test]
    fn test_market_orders_are_covered_too() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 500, 1, "alice"));
        let mut market = order_at(Side::Buy, 0, 200, 2, "alice");
        market.order_type = OrderType::Market;

        let result = engine.submit_order(market);

        assert!(result.trades.is_empty());
        assert_eq!(result.self_trade_cancelled.len(), 1);
        assert!(result.remaining_order.is_none());
    }

    #[test]
    fn test_cancel_oldest_removes_the_resting_order_and_keeps_matching() {
        let mut engine = engine_with(SelfTradePolicy::CancelOldest);
        let own = order_at(Side::Sell, 100, 50, 1, "alice");
        let own_id = own.id.clone();
        engine.submit_order(own);
        engine.submit_order(order_at(Side::Sell, 100, 30, 2, "bob"));

        let result = engine.submit_order(order_at(Side::Buy, 100, 30, 3, "alice"));

        assert_eq!(result.self_trade_cancelled, vec![own_id.clone()]);
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].maker, "bob");
        assert!(result.remaining_order.is_none());
        assert!(!engine.get_book(PAIR).unwrap().orders.contains_key(&own_id));
        assert_eq!(engine.get_book(PAIR).unwrap().best_ask(), None);
    }

    #[test]
    fn test_cancel_oldest_rests_the_remainder_when_nothing_else_matches() {
        let mut engine = engine_with(SelfTradePolicy::CancelOldest);
        engine.submit_order(order_at(Side::Sell, 100, 50, 1, "alice"));

        let result = engine.submit_order(order_at(Side::Buy, 100, 30, 2, "alice"));

        assert!(result.trades.is_empty());
        assert_eq!(result.self_trade_cancelled.len(), 1);
        assert_eq!(result.remaining_order.as_ref().unwrap().remaining(), 30);
        let book = engine.get_book(PAIR).unwrap();
        assert_eq!((book.best_bid(), book.best_ask()), (Some(100), None));
    }

    #[test]
    fn test_cancel_both_removes_the_resting_and_the_incoming_order() {
        let mut engine = engine_with(SelfTradePolicy::CancelBoth);
        let own = order_at(Side::Sell, 100, 50, 1, "alice");
        let own_id = own.id.clone();
        engine.submit_order(own);
        engine.submit_order(order_at(Side::Sell, 100, 30, 2, "bob"));
        let incoming = order_at(Side::Buy, 100, 30, 3, "alice");
        let incoming_id = incoming.id.clone();

        let result = engine.submit_order(incoming);

        assert!(result.trades.is_empty());
        assert_eq!(
            result.self_trade_cancelled,
            vec![own_id.clone(), incoming_id]
        );
        assert!(result.remaining_order.is_none());
        assert!(!engine.get_book(PAIR).unwrap().orders.contains_key(&own_id));
        // Bob's order is still there.
        assert_eq!(engine.get_depth(PAIR, 5).unwrap().asks, vec![(100, 30)]);
    }

    #[test]
    fn test_reject_incoming_refuses_the_whole_order_before_anything_trades() {
        let mut engine = engine_with(SelfTradePolicy::RejectIncoming);
        engine.submit_order(order_at(Side::Sell, 100, 10, 1, "bob"));
        let own = order_at(Side::Sell, 101, 50, 2, "alice");
        let own_id = own.id.clone();
        engine.submit_order(own);
        let before = engine.sequence(PAIR).unwrap();

        let result = engine.submit_order(order_at(Side::Buy, 101, 30, 3, "alice"));

        assert!(result.trades.is_empty());
        assert_eq!(
            result.error,
            Some(OrderBookError::SelfTrade {
                trader: "alice".to_string(),
                resting_order_id: own_id,
            })
        );
        assert!(result.remaining_order.is_none());
        assert!(result.events.is_empty());
        assert_eq!(engine.sequence(PAIR), Some(before));
        assert_eq!(result.ack.unwrap().sequence, before);
        // Bob's order was not touched either.
        assert_eq!(
            engine.get_depth(PAIR, 5).unwrap().asks,
            vec![(100, 10), (101, 50)]
        );
    }

    #[test]
    fn test_reject_incoming_allows_orders_filled_before_the_own_order() {
        let mut engine = engine_with(SelfTradePolicy::RejectIncoming);
        engine.submit_order(order_at(Side::Sell, 100, 10, 1, "bob"));
        engine.submit_order(order_at(Side::Sell, 101, 50, 2, "alice"));

        let result = engine.submit_order(order_at(Side::Buy, 101, 10, 3, "alice"));

        assert!(result.error.is_none());
        assert_eq!(result.trades.len(), 1);
        assert_eq!(result.trades[0].maker, "bob");
    }

    #[test]
    fn test_replacing_an_order_cannot_trade_against_the_same_account() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 50, 1, "alice"));
        let bid = order_at(Side::Buy, 90, 50, 2, "alice");
        let bid_id = bid.id.clone();
        engine.submit_order(bid);

        // Raising the bid to cross alice's own ask must not trade.
        let (_, result) = engine
            .replace_order(PAIR, &bid_id, 0, order_at(Side::Buy, 100, 50, 3, "alice"))
            .unwrap();

        assert!(result.trades.is_empty());
        assert_eq!(result.self_trade_cancelled, vec![bid_id.clone()]);
        assert!(!engine.get_book(PAIR).unwrap().orders.contains_key(&bid_id));
    }

    // ── Sequence numbers (#1515) ─────────────────────────────────────────────

    /// Everything that matters about a book, for comparing two of them
    type BookState = (Vec<(u128, u128)>, Vec<(u128, u128)>, Vec<String>);

    fn book_state(engine: &MatchingEngine) -> BookState {
        let book = engine.get_book(PAIR).unwrap();
        let depth = book.depth(usize::MAX);
        let mut orders: Vec<String> = book
            .orders
            .values()
            .map(|o| format!("{}:{}:{}:{}", o.id, o.price, o.filled, o.version))
            .collect();
        orders.sort();
        (depth.bids, depth.asks, orders)
    }

    #[test]
    fn test_insertions_get_consecutive_sequence_numbers() {
        let mut engine = MatchingEngine::new();
        assert_eq!(engine.sequence(PAIR), None);

        for expected in 1..=3u64 {
            let order = order_at(Side::Buy, 100 - expected as u128, 10, expected, "alice");
            let id = order.id.clone();
            let result = engine.submit_order(order);

            let ack = result.ack.unwrap();
            assert_eq!(ack.sequence, expected);
            assert_eq!(ack.order_id, id);
            assert_eq!(ack.pair_id, PAIR);
            assert_eq!(ack.status, OrderStatus::Pending);
            assert_eq!(result.events.len(), 1);
            assert_eq!(result.events[0].sequence, expected);
        }
        assert_eq!(engine.sequence(PAIR), Some(3));
    }

    #[test]
    fn test_a_trade_is_acknowledged_with_every_event_it_caused() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 10, 1, "alice")); // 1
        engine.submit_order(order_at(Side::Sell, 100, 10, 2, "bob")); // 2

        // Fills both makers (events 3 and 4) and rests the remainder (event 5).
        let result = engine.submit_order(order_at(Side::Buy, 100, 25, 3, "carol"));

        let sequences: Vec<u64> = result.events.iter().map(|e| e.sequence).collect();
        assert_eq!(sequences, vec![3, 4, 5]);
        assert!(matches!(
            result.events[0].event,
            BookEvent::OrderFilled { filled: 10, .. }
        ));
        assert!(matches!(result.events[2].event, BookEvent::OrderAdded(_)));
        let ack = result.ack.unwrap();
        assert_eq!(ack.sequence, 5);
        assert_eq!(ack.status, OrderStatus::PartiallyFilled);
    }

    #[test]
    fn test_a_fully_filled_taker_is_acknowledged_with_the_last_fill() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Sell, 100, 10, 1, "alice")); // 1

        let result = engine.submit_order(order_at(Side::Buy, 100, 10, 2, "bob"));

        let ack = result.ack.unwrap();
        assert_eq!(ack.sequence, 2);
        assert_eq!(ack.status, OrderStatus::Filled);
    }

    #[test]
    fn test_cancellation_takes_the_next_sequence_number() {
        let mut engine = MatchingEngine::new();
        let order = order_at(Side::Buy, 100, 10, 1, "alice");
        let id = order.id.clone();
        engine.submit_order(order); // 1

        let (cancelled, ack) = engine.cancel_order_acked(PAIR, &id, None).unwrap();

        assert_eq!(cancelled.id, id);
        assert_eq!(ack.sequence, 2);
        assert_eq!(ack.status, OrderStatus::Cancelled);
        assert_eq!(engine.sequence(PAIR), Some(2));
        let events = engine.get_book(PAIR).unwrap().events_since(1);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0].event, BookEvent::OrderRemoved { order_id } if *order_id == id)
        );
    }

    #[test]
    fn test_plain_cancel_is_sequenced_too() {
        let mut engine = MatchingEngine::new();
        let order = order_at(Side::Buy, 100, 10, 1, "alice");
        let id = order.id.clone();
        engine.submit_order(order);

        assert!(engine.cancel_order(PAIR, &id).is_some());
        assert_eq!(engine.sequence(PAIR), Some(2));
    }

    #[test]
    fn test_failed_cancels_do_not_consume_a_sequence_number() {
        let mut engine = MatchingEngine::new();
        let order = order_at(Side::Buy, 100, 10, 1, "alice");
        let id = order.id.clone();
        engine.submit_order(order); // 1

        assert!(engine.cancel_order(PAIR, "unknown").is_none());
        assert_eq!(
            engine.cancel_order_acked(PAIR, &id, Some(7)).unwrap_err(),
            OrderBookError::StaleVersion {
                order_id: id.clone(),
                requested: 7,
                current: 0,
            }
        );
        assert!(engine.cancel_order("no-such-pair", &id).is_none());
        assert_eq!(engine.sequence(PAIR), Some(1));
    }

    #[test]
    fn test_replacement_records_the_removal_and_the_new_order() {
        let mut engine = MatchingEngine::new();
        let order = order_at(Side::Buy, 100, 10, 1, "alice");
        let id = order.id.clone();
        engine.submit_order(order); // 1

        let (_, result) = engine
            .replace_order(PAIR, &id, 0, order_at(Side::Buy, 99, 10, 2, "alice"))
            .unwrap();

        let sequences: Vec<u64> = result.events.iter().map(|e| e.sequence).collect();
        assert_eq!(sequences, vec![2, 3]);
        assert!(matches!(
            result.events[0].event,
            BookEvent::OrderRemoved { .. }
        ));
        assert!(matches!(result.events[1].event, BookEvent::OrderAdded(_)));
        assert_eq!(result.ack.unwrap().sequence, 3);
    }

    #[test]
    fn test_markets_are_numbered_independently() {
        let mut engine = MatchingEngine::new();
        engine.submit_order(order_at(Side::Buy, 100, 10, 1, "alice"));
        engine.submit_order(order_at(Side::Buy, 99, 10, 2, "alice"));
        let mut other = order_at(Side::Buy, 100, 10, 3, "alice");
        other.token1 = "token2".to_string();

        let result = engine.submit_order(other);

        assert_eq!(result.ack.unwrap().sequence, 1);
        assert_eq!(engine.sequence(PAIR), Some(2));
        assert_eq!(engine.sequence("token0-token2"), Some(1));
    }

    #[test]
    fn test_restart_recovers_the_book_and_keeps_numbering() {
        let mut live = MatchingEngine::new();
        let resting = order_at(Side::Sell, 100, 40, 1, "alice");
        let resting_id = resting.id.clone();
        live.submit_order(resting); // 1
        live.submit_order(order_at(Side::Buy, 90, 20, 2, "bob")); // 2
        let snapshot = live.checkpoint(PAIR).unwrap();
        assert_eq!(snapshot.sequence, 2);
        assert!(live.get_book(PAIR).unwrap().events_since(0).is_empty());

        // After the snapshot: a partial fill, a new resting order, a cancel.
        live.submit_order(order_at(Side::Buy, 100, 15, 3, "carol")); // 3
        let later = order_at(Side::Sell, 120, 5, 4, "dave");
        let later_id = later.id.clone();
        live.submit_order(later); // 4
        live.cancel_order(PAIR, &later_id).unwrap(); // 5
        let events = live.get_book(PAIR).unwrap().events_since(snapshot.sequence);
        assert_eq!(events.len(), 3);

        // "Restart": a new engine rebuilt from the snapshot and the events.
        let mut restarted = MatchingEngine::new();
        restarted.recover_book(&snapshot, &events).unwrap();

        assert_eq!(book_state(&restarted), book_state(&live));
        assert_eq!(restarted.sequence(PAIR), Some(5));
        assert_eq!(
            restarted
                .get_book(PAIR)
                .unwrap()
                .get_order(&resting_id)
                .unwrap()
                .filled,
            15
        );

        // New work continues the numbering on both engines, with no reuse.
        let next = order_at(Side::Buy, 80, 1, 5, "erin");
        let live_ack = live.submit_order(next.clone()).ack.unwrap();
        let restarted_ack = restarted.submit_order(next).ack.unwrap();
        assert_eq!(live_ack.sequence, 6);
        assert_eq!(restarted_ack.sequence, 6);
        assert_eq!(book_state(&restarted), book_state(&live));
    }

    #[test]
    fn test_restart_from_a_snapshot_alone_resumes_after_its_sequence() {
        let mut live = MatchingEngine::new();
        live.submit_order(order_at(Side::Buy, 100, 10, 1, "alice"));
        live.submit_order(order_at(Side::Buy, 99, 10, 2, "alice"));
        let snapshot = live.checkpoint(PAIR).unwrap();

        let mut restarted = MatchingEngine::new();
        restarted.recover_book(&snapshot, &[]).unwrap();

        assert_eq!(restarted.sequence(PAIR), Some(2));
        let ack = restarted
            .submit_order(order_at(Side::Buy, 98, 10, 3, "alice"))
            .ack
            .unwrap();
        assert_eq!(ack.sequence, 3);
    }

    #[test]
    fn test_recovered_events_can_still_catch_clients_up() {
        let mut live = MatchingEngine::new();
        live.submit_order(order_at(Side::Buy, 100, 10, 1, "alice"));
        let snapshot = live.checkpoint(PAIR).unwrap();
        live.submit_order(order_at(Side::Buy, 99, 10, 2, "alice"));
        live.submit_order(order_at(Side::Buy, 98, 10, 3, "alice"));
        let events = live.get_book(PAIR).unwrap().events_since(snapshot.sequence);

        let mut restarted = MatchingEngine::new();
        restarted.recover_book(&snapshot, &events).unwrap();

        let catch_up = restarted.get_book(PAIR).unwrap().events_since(2);
        assert_eq!(catch_up.len(), 1);
        assert_eq!(catch_up[0].sequence, 3);
    }

    #[test]
    fn test_recovery_rejects_a_gap_in_the_events() {
        let mut live = MatchingEngine::new();
        live.submit_order(order_at(Side::Buy, 100, 10, 1, "alice"));
        let snapshot = live.checkpoint(PAIR).unwrap();
        live.submit_order(order_at(Side::Buy, 99, 10, 2, "alice"));
        live.submit_order(order_at(Side::Buy, 98, 10, 3, "alice"));
        let mut events = live.get_book(PAIR).unwrap().events_since(snapshot.sequence);
        events.remove(0); // lose event 2

        let mut restarted = MatchingEngine::new();
        let error = restarted.recover_book(&snapshot, &events).unwrap_err();

        assert_eq!(
            error,
            SnapshotError::SequenceGap {
                expected: 2,
                found: 3
            }
        );
        assert!(restarted.get_book(PAIR).is_none());
    }

    #[test]
    fn test_checkpoint_of_an_unknown_market_is_an_error() {
        let mut engine = MatchingEngine::new();
        assert!(matches!(
            engine.checkpoint("nope"),
            Err(SnapshotError::Book(OrderBookError::OrderNotFound(_)))
        ));
    }
}
