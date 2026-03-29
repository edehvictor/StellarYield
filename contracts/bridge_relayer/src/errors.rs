use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RelayerError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidPayload = 4,
    InvalidSignature = 5,
    InsufficientSignatures = 6,
    InvalidNonce = 7,
    MessageAlreadyProcessed = 8,
    QueueActive = 9,
    QueueEmpty = 10,
    InvalidMerkleProof = 11,
    AmountTooHigh = 12,
}
