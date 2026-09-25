//! # Libp2p Network Module
//!
//! Implements peer-to-peer networking for order discovery and gossip.
//! Uses Libp2p gossipsub for broadcasting orders to connected nodes.

use futures::StreamExt;
use libp2p::{
    gossipsub, mdns, noise, swarm::SwarmEvent, tcp, yamux, Multiaddr, PeerId, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;
use tokio::sync::mpsc;

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

/// Combined swarm behaviour
#[derive(libp2p::swarm::NetworkBehaviour)]
#[behaviour(to_swarm = "MatchingBehaviourEvent")]
struct MatchingBehaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
}

#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
enum MatchingBehaviourEvent {
    Gossipsub(gossipsub::Event),
    Mdns(mdns::Event),
}

impl From<gossipsub::Event> for MatchingBehaviourEvent {
    fn from(e: gossipsub::Event) -> Self {
        MatchingBehaviourEvent::Gossipsub(e)
    }
}

impl From<mdns::Event> for MatchingBehaviourEvent {
    fn from(e: mdns::Event) -> Self {
        MatchingBehaviourEvent::Mdns(e)
    }
}

/// Libp2p network node for order gossip
pub struct MatchingEngineNetwork {
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
        // Derive peer ID from a temporary keypair just to expose it
        let keypair = libp2p::identity::Keypair::generate_ed25519();
        let peer_id = PeerId::from(keypair.public());

        Ok(Self {
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
        log::info!("Will listen on port {}", self.config.tcp_port);
        Ok(())
    }

    /// Add bootstrap node
    pub fn add_bootstrap_node(&mut self, addr: Multiaddr) {
        self.config.bootstrap_nodes.push(addr);
    }

    /// Run the network event loop.
    ///
    /// Builds the full libp2p swarm and drives it to completion.
    pub async fn run(self) -> Result<(), Box<dyn std::error::Error>> {
        let mut swarm = SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )?
            .with_behaviour(
                |key| -> Result<MatchingBehaviour, Box<dyn std::error::Error + Send + Sync>> {
                    // Gossipsub
                    let message_id_fn = |message: &gossipsub::Message| {
                        let mut s = DefaultHasher::new();
                        message.data.hash(&mut s);
                        gossipsub::MessageId::from(s.finish().to_string())
                    };
                    let gossipsub_config = gossipsub::ConfigBuilder::default()
                        .heartbeat_interval(Duration::from_secs(10))
                        .validation_mode(gossipsub::ValidationMode::Strict)
                        .message_id_fn(message_id_fn)
                        .build()
                        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

                    let gossipsub = gossipsub::Behaviour::new(
                        gossipsub::MessageAuthenticity::Signed(key.clone()),
                        gossipsub_config,
                    )
                    .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.into() })?;

                    let mdns = mdns::tokio::Behaviour::new(
                        mdns::Config::default(),
                        key.public().to_peer_id(),
                    )?;

                    Ok(MatchingBehaviour { gossipsub, mdns })
                },
            )?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
            .build();

        // Subscribe to topics
        let order_topic = gossipsub::IdentTopic::new(ORDER_TOPIC);
        let trade_topic = gossipsub::IdentTopic::new(TRADE_TOPIC);
        swarm.behaviour_mut().gossipsub.subscribe(&order_topic)?;
        swarm.behaviour_mut().gossipsub.subscribe(&trade_topic)?;

        // Listen
        let addr: Multiaddr = format!("/ip4/0.0.0.0/tcp/{}", self.config.tcp_port).parse()?;
        swarm.listen_on(addr)?;

        let event_tx = self.event_tx;
        let mut message_rx = self.message_rx;

        loop {
            tokio::select! {
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
                        SwarmEvent::Behaviour(MatchingBehaviourEvent::Gossipsub(
                            gossipsub::Event::Message { message, .. },
                        )) => {
                            if let Ok(network_msg) =
                                serde_json::from_slice::<NetworkMessage>(&message.data)
                            {
                                match network_msg {
                                    NetworkMessage::NewOrder(order) => {
                                        log::info!("Received order: {}", order.id);
                                        let _ = event_tx
                                            .send(NetworkEvent::OrderReceived(order))
                                            .await;
                                    }
                                    NetworkMessage::OrderCancelled { order_id, .. } => {
                                        let _ = event_tx
                                            .send(NetworkEvent::OrderCancelled { order_id })
                                            .await;
                                    }
                                    NetworkMessage::TradeExecuted { trade_id, .. } => {
                                        let _ = event_tx
                                            .send(NetworkEvent::TradeExecuted { trade_id })
                                            .await;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        SwarmEvent::Behaviour(MatchingBehaviourEvent::Mdns(
                            mdns::Event::Discovered(list),
                        )) => {
                            for (peer_id, addr) in list {
                                log::info!("Discovered peer {} at {}", peer_id, addr);
                                swarm.dial(addr).ok();
                            }
                        }
                        _ => {}
                    }
                }
                msg = message_rx.recv() => {
                    if let Some(NetworkMessage::NewOrder(order)) = msg {
                        let data = serde_json::to_vec(&NetworkMessage::NewOrder(order))?;
                        let topic = gossipsub::IdentTopic::new(ORDER_TOPIC);
                        swarm.behaviour_mut().gossipsub.publish(topic, data).ok();
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
        use crate::orderbook::{Order, OrderType, Side};

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
