//! # Order Book Module
//!
//! Implements an in-memory order book with price-time priority matching.
//! Supports limit orders, market orders, and order cancellation.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// Order side (buy or sell)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

/// Order type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    Limit,
    Market,
}

/// Order status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    Pending,
    PartiallyFilled,
    Filled,
    Cancelled,
}

/// Represents a limit order in the order book
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    /// Unique order ID
    pub id: String,
    /// Trader's address (Stellar account)
    pub trader: String,
    /// Order side (buy/sell)
    pub side: Side,
    /// Order type (limit/market)
    pub order_type: OrderType,
    /// Price in base token units (u128 for precision)
    pub price: u128,
    /// Amount of base token
    pub amount: u128,
    /// Filled amount
    pub filled: u128,
    /// Order status
    pub status: OrderStatus,
    /// Timestamp in milliseconds
    pub timestamp: u64,
    /// Token0 address
    pub token0: String,
    /// Token1 address
    pub token1: String,
    /// Expiration timestamp (0 = no expiration)
    pub expiration: u64,
    /// Signature for order authentication
    pub signature: String,
}

impl Order {
    /// Create a new order
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        trader: String,
        side: Side,
        order_type: OrderType,
        price: u128,
        amount: u128,
        token0: String,
        token1: String,
        signature: String,
    ) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        Self {
            id: Uuid::new_v4().to_string(),
            trader,
            side,
            order_type,
            price,
            amount,
            filled: 0,
            status: OrderStatus::Pending,
            timestamp: now,
            token0,
            token1,
            expiration: 0,
            signature,
        }
    }

    /// Get remaining amount
    pub fn remaining(&self) -> u128 {
        self.amount.saturating_sub(self.filled)
    }

    /// Check if order is expired
    pub fn is_expired(&self) -> bool {
        if self.expiration == 0 {
            return false;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        now > self.expiration
    }

    /// Check if order is active
    pub fn is_active(&self) -> bool {
        self.status == OrderStatus::Pending || self.status == OrderStatus::PartiallyFilled
    }
}

/// Represents a price level in the order book
#[derive(Debug, Clone)]
pub struct PriceLevel {
    /// Price
    pub price: u128,
    /// Total amount at this price level
    pub total_amount: u128,
    /// Orders at this price level (ordered by time)
    pub orders: VecDeque<String>, // Order IDs
}

impl PriceLevel {
    pub fn new(price: u128) -> Self {
        Self {
            price,
            total_amount: 0,
            orders: VecDeque::new(),
        }
    }
}

/// Order book side (bids or asks)
#[derive(Debug, Clone)]
pub struct OrderBookSide {
    /// Side (buy/sell)
    pub side: Side,
    /// Price levels sorted by price
    pub levels: BTreeMap<u128, PriceLevel>,
}

impl OrderBookSide {
    pub fn new(side: Side) -> Self {
        Self {
            side,
            levels: BTreeMap::new(),
        }
    }

    /// Add an order to the book
    pub fn add_order(&mut self, order: &Order) {
        let level = self
            .levels
            .entry(order.price)
            .or_insert_with(|| PriceLevel::new(order.price));
        level.total_amount = level.total_amount.saturating_add(order.remaining());
        level.orders.push_back(order.id.clone());
    }

    /// Remove an order from the book
    pub fn remove_order(&mut self, order: &Order) {
        if let Some(level) = self.levels.get_mut(&order.price) {
            level.total_amount = level.total_amount.saturating_sub(order.remaining());
            level.orders.retain(|id| id != &order.id);

            if level.total_amount == 0 && level.orders.is_empty() {
                self.levels.remove(&order.price);
            }
        }
    }

    /// Get best price
    pub fn best_price(&self) -> Option<u128> {
        match self.side {
            Side::Buy => self.levels.keys().next_back().copied(),
            Side::Sell => self.levels.keys().next().copied(),
        }
    }

    /// Get the order IDs at the best price level
    pub fn best_orders(&self) -> Option<&VecDeque<String>> {
        let price = self.best_price()?;
        self.levels.get(&price).map(|l| &l.orders)
    }
}

/// Complete order book with bids and asks
#[derive(Debug, Clone)]
pub struct OrderBook {
    pub pair_id: String,
    pub token0: String,
    pub token1: String,
    pub bids: OrderBookSide,
    pub asks: OrderBookSide,
    pub orders: HashMap<String, Order>,
}

impl OrderBook {
    pub fn new(pair_id: String, token0: String, token1: String) -> Self {
        Self {
            pair_id,
            token0,
            token1,
            bids: OrderBookSide::new(Side::Buy),
            asks: OrderBookSide::new(Side::Sell),
            orders: HashMap::new(),
        }
    }

    pub fn add_order(&mut self, order: Order) {
        let order_id = order.id.clone();
        match order.side {
            Side::Buy => self.bids.add_order(&order),
            Side::Sell => self.asks.add_order(&order),
        }
        self.orders.insert(order_id, order);
    }

    pub fn remove_order(&mut self, order_id: &str) -> Option<Order> {
        if let Some(order) = self.orders.remove(order_id) {
            match order.side {
                Side::Buy => self.bids.remove_order(&order),
                Side::Sell => self.asks.remove_order(&order),
            }
            Some(order)
        } else {
            None
        }
    }

    pub fn get_order(&self, order_id: &str) -> Option<&Order> {
        self.orders.get(order_id)
    }

    pub fn get_order_mut(&mut self, order_id: &str) -> Option<&mut Order> {
        self.orders.get_mut(order_id)
    }

    pub fn best_bid(&self) -> Option<u128> {
        self.bids.best_price()
    }

    pub fn best_ask(&self) -> Option<u128> {
        self.asks.best_price()
    }

    pub fn spread(&self) -> Option<u128> {
        match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) => Some(ask.saturating_sub(bid)),
            _ => None,
        }
    }

    pub fn mid_price(&self) -> Option<u128> {
        match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) => Some(bid.saturating_add(ask) / 2),
            _ => None,
        }
    }

    /// Return a depth snapshot with up to `levels` price levels on each side.
    pub fn depth(&self, levels: usize) -> OrderBookDepth {
        let bids: Vec<(u128, u128)> = self
            .bids
            .levels
            .iter()
            .rev()
            .take(levels)
            .map(|(price, level)| (*price, level.total_amount))
            .collect();

        let asks: Vec<(u128, u128)> = self
            .asks
            .levels
            .iter()
            .take(levels)
            .map(|(price, level)| (*price, level.total_amount))
            .collect();

        OrderBookDepth { bids, asks }
    }

    pub fn cancel_all_for_trader(&mut self, trader: &str) -> Vec<String> {
        let order_ids: Vec<String> = self
            .orders
            .iter()
            .filter(|(_, order)| order.trader == trader && order.is_active())
            .map(|(id, _)| id.clone())
            .collect();
        for order_id in &order_ids {
            self.remove_order(order_id);
        }
        order_ids
    }

    /// Remove all expired active orders from the book.
    /// Returns the IDs of cleaned orders.
    pub fn cleanup_expired(&mut self) -> Vec<String> {
        let expired_ids: Vec<String> = self
            .orders
            .iter()
            .filter(|(_, order)| order.is_expired() && order.is_active())
            .map(|(id, _)| id.clone())
            .collect();

        for order_id in &expired_ids {
            if let Some(mut order) = self.remove_order(order_id) {
                order.status = OrderStatus::Cancelled;
            }
        }

        expired_ids
    }
}

/// Depth snapshot returned by `OrderBook::depth`.
#[derive(Debug, Clone)]
pub struct OrderBookDepth {
    /// (price, total_amount) pairs, best bid first
    pub bids: Vec<(u128, u128)>,
    /// (price, total_amount) pairs, best ask first
    pub asks: Vec<(u128, u128)>,
}

/// Trade execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub maker_order_id: String,
    pub taker_order_id: String,
    pub maker: String,
    pub taker: String,
    pub price: u128,
    pub amount: u128,
    pub timestamp: u64,
    pub token0: String,
    pub token1: String,
    pub side: Side,
}

impl Trade {
    pub fn new(maker_order: &Order, taker_order: &Order, amount: u128, price: u128) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        Self {
            id: Uuid::new_v4().to_string(),
            maker_order_id: maker_order.id.clone(),
            taker_order_id: taker_order.id.clone(),
            maker: maker_order.trader.clone(),
            taker: taker_order.trader.clone(),
            price,
            amount,
            timestamp: now,
            token0: maker_order.token0.clone(),
            token1: maker_order.token1.clone(),
            side: taker_order.side,
        }
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
    fn test_order_creation() {
        let order = create_test_order(Side::Buy, 100, 1000);
        assert_eq!(order.side, Side::Buy);
        assert_eq!(order.price, 100);
        assert_eq!(order.amount, 1000);
        assert_eq!(order.remaining(), 1000);
    }

    #[test]
    fn test_order_book_add_order() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let order = create_test_order(Side::Buy, 100, 1000);
        book.add_order(order.clone());

        assert_eq!(book.best_bid(), Some(100));
    }

    #[test]
    fn test_order_book_spread() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let bid = create_test_order(Side::Buy, 100, 1000);
        book.add_order(bid);

        let ask = create_test_order(Side::Sell, 105, 1000);
        book.add_order(ask);

        assert_eq!(book.spread(), Some(5));
    }

    fn create_expired_order(side: Side, price: u128, amount: u128) -> Order {
        let mut order = Order::new(
            "trader".to_string(),
            side,
            OrderType::Limit,
            price,
            amount,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        );
        order.expiration = 1; // already expired
        order
    }

    #[test]
    fn test_cleanup_expired_removes_expired_orders() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let expired = create_expired_order(Side::Buy, 100, 1000);
        let expired_id = expired.id.clone();
        book.add_order(expired);

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0], expired_id);
        assert!(book.get_order(&expired_id).is_none());
    }

    #[test]
    fn test_cleanup_expired_preserves_active_orders() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let active = create_test_order(Side::Buy, 100, 1000);
        let active_id = active.id.clone();
        book.add_order(active);

        let expired = create_expired_order(Side::Buy, 90, 500);
        book.add_order(expired);

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 1);
        assert!(book.get_order(&active_id).is_some());
    }

    #[test]
    fn test_cleanup_expired_ignores_filled_orders() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let mut filled = create_expired_order(Side::Buy, 100, 1000);
        filled.status = OrderStatus::Filled;
        filled.filled = 1000;
        let filled_id = filled.id.clone();
        book.add_order(filled);

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 0);
    }

    #[test]
    fn test_cleanup_expired_ignores_cancelled_orders() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let mut cancelled = create_expired_order(Side::Buy, 100, 1000);
        cancelled.status = OrderStatus::Cancelled;
        book.add_order(cancelled);

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 0);
    }

    #[test]
    fn test_cleanup_expired_no_expiration_orders_stay() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let no_expiry = create_test_order(Side::Buy, 100, 1000);
        assert_eq!(no_expiry.expiration, 0);
        let no_expiry_id = no_expiry.id.clone();
        book.add_order(no_expiry);

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 0);
        assert!(book.get_order(&no_expiry_id).is_some());
    }

    #[test]
    fn test_cleanup_expired_mixed_orders() {
        let mut book = OrderBook::new(
            "TOKEN0-TOKEN1".to_string(),
            "token0".to_string(),
            "token1".to_string(),
        );

        let active = create_test_order(Side::Buy, 100, 1000);
        let active_id = active.id.clone();
        book.add_order(active);

        let expired_buy = create_expired_order(Side::Buy, 90, 500);
        let expired_buy_id = expired_buy.id.clone();
        book.add_order(expired_buy);

        let expired_sell = create_expired_order(Side::Sell, 110, 300);
        let expired_sell_id = expired_sell.id.clone();
        book.add_order(expired_sell);

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 2);
        assert!(cleaned.contains(&expired_buy_id));
        assert!(cleaned.contains(&expired_sell_id));
        assert!(book.get_order(&active_id).is_some());
        assert!(book.get_order(&expired_buy_id).is_none());
        assert!(book.get_order(&expired_sell_id).is_none());
    }
}
