//! # Order Book Module
//!
//! Implements an in-memory order book with price-time priority matching.
//! Supports limit orders, market orders, and order cancellation.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

use crate::network::tie_break::MatchPriority;

pub mod snapshot;

pub use snapshot::{BookEvent, OrderBookSnapshot, SequencedEvent, SnapshotError};

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

/// Errors raised while applying a fill to an order
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FillError {
    /// The fill is larger than what is left on the order
    #[error("fill quantity {requested} exceeds the remaining quantity {remaining}")]
    ExceedsRemaining { requested: u128, remaining: u128 },
    /// Adding the fill to the filled quantity would overflow `u128`
    #[error("filled quantity overflowed u128")]
    Overflow,
}

/// Errors raised by order book mutations
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OrderBookError {
    /// No resting order has this ID
    #[error("order {0} not found")]
    OrderNotFound(String),
    /// The request was made against an older version of the order than the one
    /// now resting in the book, e.g. a delayed cancel that arrives after the
    /// order was replaced
    #[error("stale request for order {order_id}: carried version {requested}, current version is {current}")]
    StaleVersion {
        order_id: String,
        requested: u64,
        current: u64,
    },
    /// Only the trader who owns an order may replace it
    #[error("order {0} belongs to a different trader")]
    TraderMismatch(String),
    /// A price level's total quantity would overflow `u128`
    #[error("total quantity at price {price} overflowed u128")]
    LevelOverflow { price: u128 },
    /// A price level's total is smaller than the quantity being removed from it,
    /// which means the level and the orders resting in it disagree
    #[error("total quantity at price {price} is out of sync with its orders")]
    LevelOutOfSync { price: u128 },
    /// The order would trade against a resting order of the same trader
    #[error("order would trade against {resting_order_id}, another order of trader {trader}")]
    SelfTrade {
        trader: String,
        resting_order_id: String,
    },
    /// The fill itself was invalid
    #[error(transparent)]
    Fill(#[from] FillError),
}

fn is_zero(value: &u64) -> bool {
    *value == 0
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
    /// Version of this order ID. It starts at 0 and is bumped each time the
    /// order is replaced, so a request aimed at an older version (a delayed
    /// cancel, say) can be recognised and rejected. Omitted from the encoded
    /// form while 0 so existing snapshots and their checksums are unchanged.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub version: u64,
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
            version: 0,
        }
    }

    /// The filled quantity this order would have after filling `quantity`
    /// more, without changing the order. Fails instead of saturating when the
    /// fill is larger than what is left or the sum would overflow.
    pub fn checked_filled_after(&self, quantity: u128) -> Result<u128, FillError> {
        // A filled quantity above the order amount (corrupt state) leaves nothing to fill.
        let remaining = self.remaining();
        if quantity > remaining {
            return Err(FillError::ExceedsRemaining {
                requested: quantity,
                remaining,
            });
        }
        self.filled.checked_add(quantity).ok_or(FillError::Overflow)
    }

    /// Apply a fill of `quantity` and update the status. The order is left
    /// untouched when the fill is rejected.
    pub fn apply_fill(&mut self, quantity: u128) -> Result<(), FillError> {
        let filled = self.checked_filled_after(quantity)?;
        self.filled = filled;
        self.status = if self.filled >= self.amount {
            OrderStatus::Filled
        } else if self.filled > 0 {
            OrderStatus::PartiallyFilled
        } else {
            self.status
        };
        Ok(())
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
    /// Orders at this price level, in canonical match order
    /// (timestamp, then order ID) so every peer agrees on queue position
    pub orders: VecDeque<String>, // Order IDs
    /// Match priority of each entry in `orders`, kept index-aligned
    priorities: VecDeque<MatchPriority>,
}

impl PriceLevel {
    pub fn new(price: u128) -> Self {
        Self {
            price,
            total_amount: 0,
            orders: VecDeque::new(),
            priorities: VecDeque::new(),
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
    pub fn add_order(&mut self, order: &Order) -> Result<(), OrderBookError> {
        let level = self
            .levels
            .entry(order.price)
            .or_insert_with(|| PriceLevel::new(order.price));
        level.total_amount = match level.total_amount.checked_add(order.remaining()) {
            Some(total) => total,
            None => {
                // Do not leave an empty level behind when the first order overflows.
                if level.orders.is_empty() {
                    self.levels.remove(&order.price);
                }
                return Err(OrderBookError::LevelOverflow { price: order.price });
            }
        };
        // Insert by canonical priority rather than arrival so that peers
        // receiving the same orders in a different sequence build the same queue.
        let priority = MatchPriority::of(order);
        let index = level.priorities.partition_point(|p| p <= &priority);
        level.priorities.insert(index, priority);
        level.orders.insert(index, order.id.clone());
        Ok(())
    }

    /// Reduce a resting order's price level total by a filled `quantity`. The
    /// order keeps its queue position.
    pub fn reduce_level(&mut self, price: u128, quantity: u128) -> Result<(), OrderBookError> {
        let level = self
            .levels
            .get_mut(&price)
            .ok_or(OrderBookError::LevelOutOfSync { price })?;
        level.total_amount = level
            .total_amount
            .checked_sub(quantity)
            .ok_or(OrderBookError::LevelOutOfSync { price })?;
        Ok(())
    }

    /// Remove an order from the book
    pub fn remove_order(&mut self, order: &Order) {
        if let Some(level) = self.levels.get_mut(&order.price) {
            // The level total is the sum of the remaining quantity of its orders,
            // so removing an order can never take more than the level holds.
            debug_assert!(level.total_amount >= order.remaining());
            level.total_amount = level.total_amount.saturating_sub(order.remaining());
            if let Some(index) = level.orders.iter().position(|id| id == &order.id) {
                level.orders.remove(index);
                level.priorities.remove(index);
            }

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
    /// Sequence number of the last event recorded for this market. It only
    /// ever increases, including across a snapshot restore.
    sequence: u64,
    /// Recorded events that have not been trimmed by a checkpoint
    journal: Vec<SequencedEvent>,
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
            sequence: 0,
            journal: Vec::new(),
        }
    }

    /// Sequence number of the last event recorded for this market (0 when
    /// nothing has happened yet). Each recorded event takes the next number, so
    /// a client that sees a gap knows it missed an update.
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    /// Record `event` as the next event of this market and return it.
    pub(crate) fn record(&mut self, event: BookEvent) -> SequencedEvent {
        self.sequence += 1;
        let sequenced = SequencedEvent {
            sequence: self.sequence,
            event,
        };
        self.journal.push(sequenced.clone());
        sequenced
    }

    /// Recorded events with a sequence number greater than `after`, oldest first.
    pub fn events_since(&self, after: u64) -> Vec<SequencedEvent> {
        self.journal
            .iter()
            .filter(|event| event.sequence > after)
            .cloned()
            .collect()
    }

    /// Drop recorded events up to and including `through`, once a snapshot
    /// covers them.
    pub fn trim_journal(&mut self, through: u64) {
        self.journal.retain(|event| event.sequence > through);
    }

    /// The ID of the first resting order of `taker`'s own trader that `taker`
    /// would trade against before it is filled, if any.
    pub fn find_self_match(&self, taker: &Order) -> Option<&str> {
        let mut needed = taker.remaining();
        let queues: Box<dyn Iterator<Item = (&u128, &PriceLevel)>> = match taker.side {
            Side::Buy => Box::new(self.asks.levels.iter()),
            Side::Sell => Box::new(self.bids.levels.iter().rev()),
        };
        for (price, level) in queues {
            if taker.order_type == OrderType::Limit {
                let crosses = match taker.side {
                    Side::Buy => taker.price >= *price,
                    Side::Sell => taker.price <= *price,
                };
                if !crosses {
                    return None;
                }
            }
            for id in &level.orders {
                let maker = self.orders.get(id)?;
                if maker.trader == taker.trader {
                    return Some(id.as_str());
                }
                needed = needed.saturating_sub(maker.remaining());
                if needed == 0 {
                    return None;
                }
            }
        }
        None
    }

    pub fn add_order(&mut self, order: Order) -> Result<(), OrderBookError> {
        let order_id = order.id.clone();
        match order.side {
            Side::Buy => self.bids.add_order(&order)?,
            Side::Sell => self.asks.add_order(&order)?,
        }
        self.orders.insert(order_id, order);
        Ok(())
    }

    /// Fill a resting order by `quantity`.
    ///
    /// The order, its price level total and its queue position are updated
    /// together: a partially filled order keeps its original time priority and
    /// is only removed from the book once it is completely filled. Returns
    /// `true` when the order was completely filled (and removed). Nothing is
    /// changed when the fill is rejected.
    pub fn fill_order(&mut self, order_id: &str, quantity: u128) -> Result<bool, OrderBookError> {
        let order = self
            .orders
            .get(order_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?;
        let filled = order.checked_filled_after(quantity)?;
        let (side, price) = (order.side, order.price);

        match side {
            Side::Buy => self.bids.reduce_level(price, quantity)?,
            Side::Sell => self.asks.reduce_level(price, quantity)?,
        }

        let completely_filled = {
            let order = self
                .orders
                .get_mut(order_id)
                .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?;
            order.filled = filled;
            let done = order.filled >= order.amount;
            order.status = if done {
                OrderStatus::Filled
            } else {
                OrderStatus::PartiallyFilled
            };
            done
        };
        if completely_filled {
            self.remove_order(order_id);
        }
        Ok(completely_filled)
    }

    /// Cancel an order, but only if it is still at `expected_version`.
    ///
    /// A cancel that was sent for an earlier version of the order (before it
    /// was replaced) is rejected with [`OrderBookError::StaleVersion`] and the
    /// newer order stays in the book.
    pub fn cancel_versioned(
        &mut self,
        order_id: &str,
        expected_version: u64,
    ) -> Result<Order, OrderBookError> {
        let current = self
            .orders
            .get(order_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?
            .version;
        if current != expected_version {
            return Err(OrderBookError::StaleVersion {
                order_id: order_id.to_string(),
                requested: expected_version,
                current,
            });
        }
        self.remove_order(order_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))
    }

    /// Take the order being replaced out of the book, after checking that the
    /// request targets its current version and comes from its owner. Returns
    /// the removed order and the version the replacement must carry.
    pub fn detach_for_replacement(
        &mut self,
        order_id: &str,
        expected_version: u64,
        trader: &str,
    ) -> Result<(Order, u64), OrderBookError> {
        let existing = self
            .orders
            .get(order_id)
            .ok_or_else(|| OrderBookError::OrderNotFound(order_id.to_string()))?;
        if existing.trader != trader {
            return Err(OrderBookError::TraderMismatch(order_id.to_string()));
        }
        let next_version =
            existing
                .version
                .checked_add(1)
                .ok_or_else(|| OrderBookError::StaleVersion {
                    order_id: order_id.to_string(),
                    requested: expected_version,
                    current: existing.version,
                })?;
        let old = self.cancel_versioned(order_id, expected_version)?;
        Ok((old, next_version))
    }

    /// Replace a resting order with `replacement` under the same order ID.
    ///
    /// The replacement is a new order: it starts unfilled, gets the next
    /// version and joins the back of the queue at its price (a replaced order
    /// does not keep the old order's time priority). Returns the order that
    /// was replaced. For a replacement that may cross the book use
    /// [`crate::matching::MatchingEngine::replace_order`].
    pub fn replace_order(
        &mut self,
        order_id: &str,
        expected_version: u64,
        mut replacement: Order,
    ) -> Result<Order, OrderBookError> {
        let (old, next_version) =
            self.detach_for_replacement(order_id, expected_version, &replacement.trader)?;
        replacement.id = order_id.to_string();
        replacement.version = next_version;
        replacement.filled = 0;
        replacement.status = OrderStatus::Pending;
        match self.add_order(replacement) {
            Ok(()) => Ok(old),
            Err(error) => {
                // Put the original back so a rejected replacement changes nothing.
                self.add_order(old)?;
                Err(error)
            }
        }
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
        book.add_order(order.clone()).unwrap();

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
        book.add_order(bid).unwrap();

        let ask = create_test_order(Side::Sell, 105, 1000);
        book.add_order(ask).unwrap();

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
        book.add_order(expired).unwrap();

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
        book.add_order(active).unwrap();

        let expired = create_expired_order(Side::Buy, 90, 500);
        book.add_order(expired).unwrap();

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
        book.add_order(filled).unwrap();

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
        book.add_order(cancelled).unwrap();

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
        book.add_order(no_expiry).unwrap();

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
        book.add_order(active).unwrap();

        let expired_buy = create_expired_order(Side::Buy, 90, 500);
        let expired_buy_id = expired_buy.id.clone();
        book.add_order(expired_buy).unwrap();

        let expired_sell = create_expired_order(Side::Sell, 110, 300);
        let expired_sell_id = expired_sell.id.clone();
        book.add_order(expired_sell).unwrap();

        let cleaned = book.cleanup_expired();
        assert_eq!(cleaned.len(), 2);
        assert!(cleaned.contains(&expired_buy_id));
        assert!(cleaned.contains(&expired_sell_id));
        assert!(book.get_order(&active_id).is_some());
        assert!(book.get_order(&expired_buy_id).is_none());
        assert!(book.get_order(&expired_sell_id).is_none());
    }
}
