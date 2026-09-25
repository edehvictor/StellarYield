//! # Matching Engine Node
//!
//! Main entry point for the matching engine node.
//! Runs the Libp2p network, order matching, and settlement generation.

use ed25519_dalek::SigningKey;
use matching_engine::{
    MatchingEngine, MatchingEngineNetwork, NetworkConfig, NetworkEvent, NetworkMessage,
    SettlementBatch, SettlementPayload,
};
use rand::rngs::OsRng;
use std::time::Duration;
use tokio::sync::mpsc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("Starting Matching Engine Node...");

    let mut csprng = OsRng;
    let engine_key = SigningKey::generate(&mut csprng);
    log::info!("Engine public key: {:?}", engine_key.verifying_key());

    let (event_tx, mut event_rx) = mpsc::channel::<NetworkEvent>(100);
    let (message_tx, message_rx) = mpsc::channel::<NetworkMessage>(100);

    let config = NetworkConfig {
        tcp_port: 40000,
        bootstrap_nodes: vec![],
        enable_mdns: true,
    };

    let mut network = MatchingEngineNetwork::new(config, event_tx, message_rx).await?;
    log::info!("Network node created with peer ID: {}", network.peer_id());

    network.listen().await?;

    let mut matching_engine = MatchingEngine::new();

    let engine_key_clone = engine_key.clone();
    let (settlement_tx, mut settlement_rx) =
        mpsc::channel::<Vec<matching_engine::orderbook::Trade>>(100);

    tokio::spawn(async move {
        let mut batch_trades = Vec::new();
        let mut interval = tokio::time::interval(Duration::from_secs(5));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if !batch_trades.is_empty() {
                        log::info!("Processing settlement batch with {} trades", batch_trades.len());

                        let mut settlements = Vec::new();
                        for trade in &batch_trades {
                            let maker_key = &engine_key_clone;
                            let taker_key = &engine_key_clone;
                            match SettlementPayload::from_trade(trade, maker_key, taker_key, &engine_key_clone) {
                                Ok(s) => settlements.push(s),
                                Err(e) => log::error!("Failed to create settlement: {}", e),
                            }
                        }

                        let batch = SettlementBatch::new(settlements);
                        log::info!(
                            "Created settlement batch: {} (amount0={}, amount1={})",
                            batch.batch_id,
                            batch.total_amount0,
                            batch.total_amount1,
                        );

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

    loop {
        tokio::select! {
            event = event_rx.recv() => {
                if let Some(event) = event {
                    match event {
                        NetworkEvent::OrderReceived(order) => {
                            log::info!("Received order from network: {}", order.id);
                            let result = matching_engine.submit_order(order);

                            if !result.trades.is_empty() {
                                log::info!("Matched {} trades", result.trades.len());
                                let _ = settlement_tx.send(result.trades.clone()).await;

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
            _ = tokio::time::sleep(Duration::from_secs(60)) => {
                log::info!("Running periodic cleanup...");
            }
        }
    }
}
