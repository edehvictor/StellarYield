//! Versioned contract event schemas (#904)
//!
//! Events are emitted with version information to support backward compatibility
//! as the contract evolves. Decoders should handle multiple schema versions.

use soroban_sdk::{Env, IntoVal, Symbol, Val};

/// Current event schema version for all vault events
pub const VAULT_EVENT_SCHEMA_VERSION: u32 = 1;

/// Event schema versions for different event types
#[derive(Clone, Copy, Debug)]
pub struct EventVersion {
    pub event_type: &'static str,
    pub schema_version: u32,
}

// Vault Event Versions
pub const DEPOSIT_EVENT_V1: EventVersion = EventVersion {
    event_type: "deposit",
    schema_version: 1,
};

pub const WITHDRAWAL_EVENT_V1: EventVersion = EventVersion {
    event_type: "withdrawal",
    schema_version: 1,
};

pub const ADMIN_ACTION_EVENT_V1: EventVersion = EventVersion {
    event_type: "admin_action",
    schema_version: 1,
};

pub const HARVEST_EVENT_V1: EventVersion = EventVersion {
    event_type: "harvest",
    schema_version: 1,
};

/// Emit a versioned event with schema version information.
///
/// This helper ensures all events include version metadata for future
/// decoder compatibility. When event schemas evolve, decoders can check
/// the version field to determine how to interpret the payload.
///
/// # Arguments
/// * `env` - The Soroban environment
/// * `topic` - The event topic (e.g., "deposit")
/// * `version` - The schema version for this event
/// * `data` - The event data payload
pub fn emit_versioned_event<T>(env: &Env, topic: Symbol, version: u32, data: T)
where
    T: IntoVal<Env, Val>,
{
    // Emit event with version information
    // Topic format: "event_v<version>" to allow version-aware filtering
    env.events().publish((topic, version), data);
}

/// Marker type for unknown/future event versions
///
/// If a decoder encounters an event version it doesn't recognize,
/// it should route to a dead-letter queue rather than attempting
/// to decode with the wrong schema version.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventDecodeStatus {
    /// Event version is recognized and can be decoded
    Recognized,
    /// Event version is unknown (future upgrade)
    Unknown,
    /// Event is malformed
    Invalid,
}

/// Verify if an event version is compatible with this decoder
pub fn check_event_version(event_type: &str, version: u32) -> EventDecodeStatus {
    match (event_type, version) {
        ("deposit", 1) => EventDecodeStatus::Recognized,
        ("withdrawal", 1) => EventDecodeStatus::Recognized,
        ("admin_action", 1) => EventDecodeStatus::Recognized,
        ("harvest", 1) => EventDecodeStatus::Recognized,
        // Future versions go to dead-letter
        (_, future) if future > VAULT_EVENT_SCHEMA_VERSION => EventDecodeStatus::Unknown,
        _ => EventDecodeStatus::Invalid,
    }
}
