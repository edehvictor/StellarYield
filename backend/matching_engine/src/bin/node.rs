//! # Matching Engine Node
//!
//! Main entry point for the matching engine node.
//! Runs the Libp2p network, order matching, and settlement generation.

use matching_engine::{
    MatchingEngine, MatchingEngineNetwork, NetworkConfig, NetworkEvent, NetworkMessage,
    Order, SettlementPayload, SettlementBatch,
};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use tokio::sync::mpsc;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("Starting Matching Engine Node...");

    // Generate engine keypair for signing settlements
    let mut csprng = OsRng;
    let engine_key = SigningKey::generate(&mut csprng);
    log::info!("Engine public key: {:?}", engine_key.verifying_key());

    // Create channels for network communication
    let (event_tx, mut event_rx) = mpsc::channel::<NetworkEvent>(100);
    let (message_tx, message_rx) = mpsc::channel::<NetworkMessage>(100);

    // Create network configuration
    let config = NetworkConfig {
        tcp_port: 40000,
        bootstrap_nodes: vec![],
        enable_mdns: true,
    };

    // Create network node
    let mut network = MatchingEngineNetwork::new(config, event_tx, message_rx).await?;
    log::info!("Network node created with peer ID: {}", network.peer_id());

    // Start listening
    network.listen().await?;

    // Create matching engine
    let mut matching_engine = MatchingEngine::new();

    // Spawn settlement batch processor
    let engine_key_clone = engine_key.clone();
    let (settlement_tx, mut settlement_rx) = mpsc::channel::<Vec<matching_engine::orderbook::Trade>>(100);
    
    tokio::spawn(async move {
        let mut batch_trades = Vec::new();
        let mut interval = tokio::time::interval(Duration::from_secs(5)); // Batch every 5 seconds

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    // Process batch
                    if !batch_trades.is_empty() {
                        log::info!("Processing settlement batch with {} trades", batch_trades.len());
                        
                        // Create settlements for all trades in batch
                        let mut settlements = Vec::new();
                        for trade in &batch_trades {
                            // In production, would need actual maker/taker keys
                            // For now, use engine key for all
                            let maker_key = &engine_key_clone;
                            let taker_key = &engine_key_clone;
                            
                            match SettlementPayload::from_trade(trade, maker_key, taker_key, &engine_key_clone) {
                                Ok(settlement) => settlements.push(settlement),
                                Err(e) => log::error!("Failed to create settlement: {}", e),
                            }
                        }

                        let batch = SettlementBatch::new(settlements);
                        log::info!("Created settlement batch: {}", batch.batch_id);
                        log::info!("Total amount0: {}, amount1: {}", batch.total_amount0, batch.total_amount1);
                        
                        // In production, would submit to Soroban chain here
                        // submit_to_chain(&batch).await?;

                        batch_trades.clear();
                    }
                }
                trades = settlement_rx.recv() => {
                    if let Some(trades) = trades {
                        batch_trades.extend(trades);
                    }
                }
            }
        }
    });

    log::info!("Matching Engine Node is running!");

    // Main event loop
    loop {
        tokio::select! {
            // Handle network events
            event = event_rx.recv() => {
                if let Some(event) = event {
                    match event {
                        NetworkEvent::OrderReceived(order) => {
                            log::info!("Received order from network: {}", order.id);
                            
                            // Submit order to matching engine
                            let result = matching_engine.submit_order(order);
                            
                            // Broadcast any trades
                            if !result.trades.is_empty() {
                                log::info!("Matched {} trades", result.trades.len());
                                
                                // Send trades to settlement processor
                                let _ = settlement_tx.send(result.trades.clone()).await;
                                
                                // Broadcast trade notifications
                                for trade in &result.trades {
                                    let msg = NetworkMessage::TradeExecuted {
                                        trade_id: trade.id.clone(),
                                        data: String::new(),
                                    };
                                    let _ = message_tx.send(msg).await;
                                }
                            }
                        }
                        NetworkEvent::OrderCancelled { order_id } => {
                            log::info!("Order cancelled: {}", order_id);
                            // Remove from order book
                            // matching_engine.cancel_order(...);
                        }
                        NetworkEvent::PeerConnected(peer_id) => {
                            log::info!("Peer connected: {}", peer_id);
                        }
                        NetworkEvent::PeerDisconnected(peer_id) => {
                            log::info!("Peer disconnected: {}", peer_id);
                        }
                        NetworkEvent::TradeExecuted { trade_id } => {
                            log::info!("Trade executed notification: {}", trade_id);
                        }
                    }
                }
            }

            // Periodic cleanup
            _ = tokio::time::sleep(Duration::from_secs(60)) => {
                log::info!("Running periodic cleanup...");
                // Remove expired orders, etc.
            }
        }
    }
}
