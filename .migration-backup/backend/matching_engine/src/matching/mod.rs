//! # Matching Engine Module
//!
//! Implements the core order matching algorithm with price-time priority.
//! Matches buy and sell orders and generates trade executions.

use crate::orderbook::{Order, OrderBook, OrderStatus, OrderType, Side, Trade};

/// Matching engine result
#[derive(Debug, Clone)]
pub struct MatchResult {
    /// Trades executed
    pub trades: Vec<Trade>,
    /// Updated taker order
    pub remaining_order: Option<Order>,
    /// Orders that were fully filled
    pub filled_orders: Vec<String>,
}

impl MatchResult {
    pub fn new() -> Self {
        Self {
            trades: Vec::new(),
            remaining_order: None,
            filled_orders: Vec::new(),
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
                book.add_order(order.clone());
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

        match order.side {
            Side::Buy => {
                // Match against asks (sell orders)
                while order.remaining() > 0 {
                    let best_ask = match book.best_ask() {
                        Some(price) => price,
                        None => break, // No more asks
                    };

                    // For limit orders, check price
                    if order.order_type == OrderType::Limit && order.price < best_ask {
                        break; // Can't match at this price
                    }

                    // Get the best ask order
                    let best_ask_orders = book.asks.best_orders().cloned().unwrap_or_default();
                    let maker_order_id = match best_ask_orders.front() {
                        Some(id) => id.clone(),
                        None => break,
                    };

                    // Get maker order
                    let maker_order = match book.get_order_mut(&maker_order_id) {
                        Some(o) => o,
                        None => break,
                    };

                    // Calculate match amount
                    let match_amount = order.remaining().min(maker_order.remaining());
                    let match_price = maker_order.price; // Price-time priority: maker's price

                    // Create trade
                    let trade = Trade::new(maker_order, order, match_amount, match_price);

                    // Update maker order
                    maker_order.filled = maker_order.filled.saturating_add(match_amount);
                    if maker_order.filled >= maker_order.amount {
                        maker_order.status = OrderStatus::Filled;
                        result.filled_orders.push(maker_order_id.clone());
                    } else {
                        maker_order.status = OrderStatus::PartiallyFilled;
                    }

                    // Update taker order
                    order.filled = order.filled.saturating_add(match_amount);

                    // Remove filled maker order from book
                    if maker_order.status == OrderStatus::Filled {
                        book.remove_order(&maker_order_id);
                    }

                    result.trades.push(trade);
                }
            }
            Side::Sell => {
                // Match against bids (buy orders)
                while order.remaining() > 0 {
                    let best_bid = match book.best_bid() {
                        Some(price) => price,
                        None => break, // No more bids
                    };

                    // For limit orders, check price
                    if order.order_type == OrderType::Limit && order.price > best_bid {
                        break; // Can't match at this price
                    }

                    // Get the best bid order
                    let best_bid_orders = book.bids.best_orders().cloned().unwrap_or_default();
                    let maker_order_id = match best_bid_orders.front() {
                        Some(id) => id.clone(),
                        None => break,
                    };

                    // Get maker order
                    let maker_order = match book.get_order_mut(&maker_order_id) {
                        Some(o) => o,
                        None => break,
                    };

                    // Calculate match amount
                    let match_amount = order.remaining().min(maker_order.remaining());
                    let match_price = maker_order.price;

                    // Create trade
                    let trade = Trade::new(maker_order, order, match_amount, match_price);

                    // Update maker order
                    maker_order.filled = maker_order.filled.saturating_add(match_amount);
                    if maker_order.filled >= maker_order.amount {
                        maker_order.status = OrderStatus::Filled;
                        result.filled_orders.push(maker_order_id.clone());
                    } else {
                        maker_order.status = OrderStatus::PartiallyFilled;
                    }

                    // Update taker order
                    order.filled = order.filled.saturating_add(match_amount);

                    // Remove filled maker order from book
                    if maker_order.status == OrderStatus::Filled {
                        book.remove_order(&maker_order_id);
                    }

                    result.trades.push(trade);
                }
            }
        }

        result
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
}
