//! # Matching Engine Module
//!
//! Implements the core order matching algorithm with price-time priority.
//! Matches buy and sell orders and generates trade executions.

use crate::orderbook::{Order, OrderBook, OrderBookError, OrderStatus, OrderType, Side, Trade};

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
}

impl MatchResult {
    pub fn new() -> Self {
        Self {
            trades: Vec::new(),
            remaining_order: None,
            filled_orders: Vec::new(),
            error: None,
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
}

impl MatchingEngine {
    pub fn new() -> Self {
        Self {
            order_books: std::collections::HashMap::new(),
        }
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

        // Try to match the order
        let mut result = self.match_order(&mut order);

        // If there's remaining amount, add to order book
        if order.remaining() > 0 && order.order_type == OrderType::Limit {
            if let Some(book) = self.get_book_mut(&pair_id) {
                order.status = if order.filled > 0 {
                    OrderStatus::PartiallyFilled
                } else {
                    OrderStatus::Pending
                };
                if let Err(error) = book.add_order(order.clone()) {
                    result.error.get_or_insert(error);
                }
            }
        } else if order.remaining() == 0 {
            order.status = OrderStatus::Filled;
        }

        result.remaining_order = if order.remaining() > 0 {
            Some(order)
        } else {
            None
        };
        result
    }

    /// Match an order against the order book
    fn match_order(&mut self, order: &mut Order) -> MatchResult {
        let pair_id = format!("{}-{}", order.token0, order.token1);
        let mut result = MatchResult::new();

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
            let trade = match book.get_order(&maker_order_id) {
                Some(maker) => Trade::new(maker, order, match_amount, match_price),
                None => break,
            };
            match book.fill_order(&maker_order_id, match_amount) {
                Ok(maker_filled) => {
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
        self.get_book_mut(pair_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?
            .cancel_versioned(order_id, expected_version)
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
        let (old, next_version) = self
            .get_book_mut(pair_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?
            .detach_for_replacement(order_id, expected_version, &replacement.trader)?;
        replacement.id = order_id.to_string();
        replacement.version = next_version;
        replacement.filled = 0;
        replacement.status = OrderStatus::Pending;
        replacement.token0 = old.token0.clone();
        replacement.token1 = old.token1.clone();
        Ok((old, self.submit_order(replacement)))
    }

    /// Cancel an order
    pub fn cancel_order(&mut self, pair_id: &str, order_id: &str) -> Option<Order> {
        self.get_book_mut(pair_id)?.remove_order(order_id)
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

    fn create_test_order(side: Side, price: u128, amount: u128) -> Order {
        Order::new(
            "test_trader".to_string(),
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
}
