//! # Libp2p Network Module
//!
//! Implements peer-to-peer networking for order discovery and gossip.
//! Uses Libp2p gossipsub for broadcasting orders to connected nodes.

use libp2p::{
    gossipsub, mdns, noise, swarm::SwarmEvent, tcp, yamux, Multiaddr, PeerId, Swarm, SwarmBuilder,
};
use futures::{future::pending, stream::StreamExt};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;
use tokio::sync::mpsc;
use serde::{Deserialize, Serialize};

use crate::orderbook::Order;

/// Network message types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NetworkMessage {
    /// New order broadcast
    NewOrder(Order),
    /// Order cancellation
    OrderCancelled { order_id: String, signature: String },
    /// Trade execution notification
    TradeExecuted { trade_id: String, data: String },
    /// Order book sync request
    SyncRequest { pair_id: String },
    /// Order book sync response
    SyncResponse { pair_id: String, orders: Vec<Order> },
}

/// Gossipsub topic for orders
const ORDER_TOPIC: &str = "stellaryield-orders-v1";

/// Gossipsub topic for trades
const TRADE_TOPIC: &str = "stellaryield-trades-v1";

/// Network configuration
#[derive(Debug, Clone)]
pub struct NetworkConfig {
    /// TCP port to listen on
    pub tcp_port: u16,
    /// Bootstrap nodes
    pub bootstrap_nodes: Vec<Multiaddr>,
    /// Enable MDNS for local discovery
    pub enable_mdns: bool,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            tcp_port: 40000,
            bootstrap_nodes: Vec::new(),
            enable_mdns: true,
        }
    }
}

/// P2P network event
#[derive(Debug, Clone)]
pub enum NetworkEvent {
    /// Received a new order from peer
    OrderReceived(Order),
    /// Order cancelled
    OrderCancelled { order_id: String },
    /// Peer connected
    PeerConnected(PeerId),
    /// Peer disconnected
    PeerDisconnected(PeerId),
    /// Trade executed
    TradeExecuted { trade_id: String },
}

/// Libp2p network node for order gossip
pub struct MatchingEngineNetwork {
    /// Libp2p swarm
    swarm: Option<Swarm<gossipsub::Behaviour>>,
    /// MDNS behaviour for local discovery
    mdns: Option<mdns::tokio::Behaviour>,
    /// Configuration
    config: NetworkConfig,
    /// Local peer ID
    peer_id: PeerId,
    /// Channel for sending network events
    event_tx: mpsc::Sender<NetworkEvent>,
    /// Channel for receiving messages to broadcast
    message_rx: mpsc::Receiver<NetworkMessage>,
}

impl MatchingEngineNetwork {
    /// Create a new network node
    pub async fn new(
        config: NetworkConfig,
        event_tx: mpsc::Sender<NetworkEvent>,
        message_rx: mpsc::Receiver<NetworkMessage>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        // Generate keypair
        let local_key = libp2p::identity::Keypair::generate_ed25519();
        let peer_id = PeerId::from(local_key.public());

        // Create TCP transport
        let transport = tcp::tokio::Transport::new(tcp::Config::default().nodelay(true))
            .upgrade(libp2p::core::upgrade::Version::V1)
            .authenticate(noise::Config::new(&local_key)?)
            .multiplex(yamux::Config::default())
            .boxed();

        // Create gossipsub behaviour
        let gossipsub_config = gossipsub::ConfigBuilder::default()
            .heartbeat_interval(Duration::from_secs(10))
            .validation_mode(gossipsub::ValidationMode::Strict)
            .message_id_fn(|message: &gossipsub::Message| {
                let mut s = DefaultHasher::new();
                message.data.hash(&mut s);
                gossipsub::MessageId::from(s.finish().to_string())
            })
            .build()
            .expect("Valid config");

        let mut gossipsub = gossipsub::Behaviour::new(
            gossipsub::MessageAuthenticity::Signed(local_key.clone()),
            gossipsub_config,
        )
        .expect("Valid configuration");

        // Subscribe to order topic
        let order_topic = gossipsub::IdentTopic::new(ORDER_TOPIC);
        gossipsub.subscribe(&order_topic).expect("Subscription succeeded");

        // Subscribe to trade topic
        let trade_topic = gossipsub::IdentTopic::new(TRADE_TOPIC);
        gossipsub.subscribe(&trade_topic).expect("Subscription succeeded");

        // Create MDNS for local discovery
        let mdns = if config.enable_mdns {
            Some(mdns::tokio::Behaviour::new(
                mdns::Config::default(),
                peer_id,
            )?)
        } else {
            None
        };

        // Build swarm
        let swarm = SwarmBuilder::with_tokio_executor(transport, gossipsub, peer_id).build();

        Ok(Self {
            swarm: Some(swarm),
            mdns,
            config,
            peer_id,
            event_tx,
            message_rx,
        })
    }

    /// Get local peer ID
    pub fn peer_id(&self) -> PeerId {
        self.peer_id
    }

    /// Start listening on address
    pub async fn listen(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(swarm) = &mut self.swarm {
            let addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{}", self.config.tcp_port).parse()?;
            swarm.listen_on(addr)?;
            log::info!("Listening on port {}", self.config.tcp_port);
        }
        Ok(())
    }

    /// Add bootstrap node
    pub fn add_bootstrap_node(&mut self, addr: Multiaddr) {
        if let Some(swarm) = &mut self.swarm {
            let _ = swarm.dial(addr);
        }
    }

    /// Broadcast an order to all peers
    pub async fn broadcast_order(&mut self, order: &Order) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(swarm) = &mut self.swarm {
            let message = NetworkMessage::NewOrder(order.clone());
            let data = serde_json::to_vec(&message)?;
            
            let topic = gossipsub::IdentTopic::new(ORDER_TOPIC);
            if let Err(e) = swarm.behaviour_mut().publish(topic, data) {
                log::error!("Failed to publish order: {}", e);
            }
        }
        Ok(())
    }

    /// Broadcast a trade execution
    pub async fn broadcast_trade(&mut self, trade_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(swarm) = &mut self.swarm {
            let message = NetworkMessage::TradeExecuted {
                trade_id: trade_id.to_string(),
                data: String::new(),
            };
            let data = serde_json::to_vec(&message)?;
            
            let topic = gossipsub::IdentTopic::new(TRADE_TOPIC);
            if let Err(e) = swarm.behaviour_mut().publish(topic, data) {
                log::error!("Failed to publish trade: {}", e);
            }
        }
        Ok(())
    }

    /// Run the network event loop
    pub async fn run(mut self) -> Result<(), Box<dyn std::error::Error>> {
        let mut swarm = self.swarm.take().expect("Swarm should exist");
        let mut mdns = self.mdns;
        let mut event_tx = self.event_tx;
        let mut message_rx = self.message_rx;

        loop {
            tokio::select! {
                // Handle swarm events
                event = swarm.select_next_some() => {
                    match event {
                        SwarmEvent::NewListenAddr { address, .. } => {
                            log::info!("Listening on {}", address);
                        }
                        SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                            log::info!("Connected to peer {}", peer_id);
                            let _ = event_tx.send(NetworkEvent::PeerConnected(peer_id)).await;
                        }
                        SwarmEvent::ConnectionClosed { peer_id, .. } => {
                            log::info!("Disconnected from peer {}", peer_id);
                            let _ = event_tx.send(NetworkEvent::PeerDisconnected(peer_id)).await;
                        }
                        SwarmEvent::Behaviour(gossipsub::Event::Message {
                            propagation_source: _,
                            message_id: _,
                            message,
                        }) => {
                            // Handle received message
                            if let Ok(network_msg) = serde_json::from_slice::<NetworkMessage>(&message.data) {
                                match network_msg {
                                    NetworkMessage::NewOrder(order) => {
                                        log::info!("Received order from peer: {}", order.id);
                                        let _ = event_tx.send(NetworkEvent::OrderReceived(order)).await;
                                    }
                                    NetworkMessage::OrderCancelled { order_id, .. } => {
                                        log::info!("Received order cancellation: {}", order_id);
                                        let _ = event_tx.send(NetworkEvent::OrderCancelled { order_id }).await;
                                    }
                                    NetworkMessage::TradeExecuted { trade_id, .. } => {
                                        log::info!("Received trade notification: {}", trade_id);
                                        let _ = event_tx.send(NetworkEvent::TradeExecuted { trade_id }).await;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                }
                // Handle MDNS events
                event = async {
                    if let Some(ref mut m) = mdns {
                        m.select_next_some().await
                    } else {
                        pending().await
                    }
                } => {
                    match event {
                        mdns::Event::Discovered(list) => {
                            for (peer_id, addr) in list {
                                log::info!("Discovered peer {} at {}", peer_id, addr);
                                swarm.dial(addr).ok();
                            }
                        }
                        mdns::Event::Expired(list) => {
                            for (peer_id, _) in list {
                                log::info!("Peer {} expired", peer_id);
                            }
                        }
                    }
                }
                // Handle outgoing messages
                msg = message_rx.recv() => {
                    if let Some(message) = msg {
                        match message {
                            NetworkMessage::NewOrder(order) => {
                                let data = serde_json::to_vec(&NetworkMessage::NewOrder(order))?;
                                let topic = gossipsub::IdentTopic::new(ORDER_TOPIC);
                                swarm.behaviour_mut().publish(topic, data).ok();
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_network_config_default() {
        let config = NetworkConfig::default();
        assert_eq!(config.tcp_port, 40000);
        assert!(config.bootstrap_nodes.is_empty());
        assert!(config.enable_mdns);
    }

    #[test]
    fn test_network_message_serialization() {
        use crate::orderbook::{Order, Side, OrderType};
        
        let order = Order::new(
            "test".to_string(),
            Side::Buy,
            OrderType::Limit,
            100,
            1000,
            "token0".to_string(),
            "token1".to_string(),
            "sig".to_string(),
        );

        let message = NetworkMessage::NewOrder(order.clone());
        let serialized = serde_json::to_string(&message).unwrap();
        let deserialized: NetworkMessage = serde_json::from_str(&serialized).unwrap();

        match deserialized {
            NetworkMessage::NewOrder(o) => {
                assert_eq!(o.id, order.id);
                assert_eq!(o.trader, order.trader);
            }
            _ => panic!("Expected NewOrder message"),
        }
    }
}
