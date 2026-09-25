/**
 * Contract Event Fixtures
 *
 * Provides mock Soroban contract events for testing the event decoder pipeline,
 * including known, unknown, and malformed event topics.
 */

/**
 * Known/Valid event topic - represents a standard Soroban contract event.
 * Real XDR-encoded topic that would decode successfully.
 */
export const KNOWN_TOPIC_XDR = "AAAADwAAAAFtaW50"; // Base64 encoded XDR - contains 'mint'

/**
 * Unknown event topic - valid XDR encoding but represents an unrecognized event type.
 * Decoder should record this without crashing.
 */
export const UNKNOWN_TOPIC_XDR = "AAAADwAAAAVoYWNrZWQ="; // Base64 encoded XDR for unknown event

/**
 * Malformed topic - invalid XDR that cannot be decoded.
 */
export const MALFORMED_TOPIC_XDR = "!!!invalid-xdr!!!";

/**
 * Valid event value/data XDR.
 */
const VALID_DATA_XDR = "AAAABgAAAAAAAAAAAAAACgAAAGQ="; // Base64 encoded event data

/**
 * Empty/malformed event data.
 */
const EMPTY_DATA_XDR = "";

/**
 * Helper to create a mock Stellar event with just XDR strings.
 * Simplifies testing without deep Stellar SDK API knowledge.
 */
function createMockEvent(
  topicXdr: string,
  dataXdr: string,
  ledger: number,
  txHash: string = "abcd1234efgh5678ijkl9012mnop3456",
  contractId: string = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
) {
  // Create a mock object that behaves like a Stellar event
  // The toXDR() method will be called by the decoder
  return {
    topic: [
      {
        toXDR: (format?: string) => topicXdr,
      },
    ],
    value: {
      toXDR: (format?: string) => dataXdr,
    },
    ledger,
    txHash,
    contractId,
  };
}

/**
 * Fixture: Event with known, decodable topic.
 * Expected: Successfully decode and store in events table.
 */
export function createKnownEventFixture() {
  return createMockEvent(
    KNOWN_TOPIC_XDR,
    VALID_DATA_XDR,
    1000,
    "txhash_known_001",
  );
}

/**
 * Fixture: Event with unknown topic (not in decoder's recognized set).
 * Expected: Record in dead-letter queue with UnknownTopicError classification.
 */
export function createUnknownTopicFixture() {
  return createMockEvent(
    UNKNOWN_TOPIC_XDR,
    VALID_DATA_XDR,
    1001,
    "txhash_unknown_001",
  );
}

/**
 * Fixture: Event with malformed topic XDR.
 * Expected: Record in dead-letter queue with DecodeError classification.
 */
export function createMalformedTopicFixture() {
  return createMockEvent(
    MALFORMED_TOPIC_XDR,
    VALID_DATA_XDR,
    1002,
    "txhash_malformed_001",
  );
}

/**
 * Fixture: Event with empty/invalid data XDR.
 * Expected: Record in dead-letter queue with DecodeError classification.
 */
export function createMalformedDataFixture() {
  return createMockEvent(
    KNOWN_TOPIC_XDR,
    EMPTY_DATA_XDR,
    1003,
    "txhash_malformed_data_001",
  );
}

/**
 * Fixture: Mixed batch of events (known, unknown, malformed).
 * Expected: Known events processed, others dead-lettered; pipeline continues.
 */
export function createMixedEventBatch() {
  return [
    createKnownEventFixture(),
    createUnknownTopicFixture(),
    createMalformedTopicFixture(),
    createKnownEventFixture(), // Another known event after failures
    createMalformedDataFixture(),
    createUnknownTopicFixture(), // Another unknown event
  ];
}

/**
 * Fixture: Large batch with mostly unknown topics (edge case).
 * Expected: Unknown events recorded separately; valid events still flow through.
 */
export function createBatchWithMostlyUnknownTopics() {
  const batch = [];
  for (let i = 0; i < 50; i++) {
    if (i % 10 === 0) {
      // One known event per 10
      batch.push(
        createMockEvent(
          KNOWN_TOPIC_XDR,
          VALID_DATA_XDR,
          2000 + i,
          `txhash_known_${i}`,
        ),
      );
    } else {
      // Rest are unknown
      batch.push(
        createMockEvent(
          UNKNOWN_TOPIC_XDR,
          VALID_DATA_XDR,
          2000 + i,
          `txhash_unknown_${i}`,
        ),
      );
    }
  }
  return batch;
}

/**
 * Fixture: Event with topic as vector (multiple ScVal elements).
 * Some Soroban events have topics as arrays; ensure we handle this.
 */
export function createEventWithTopicVector() {
  return {
    topic: [
      { toXDR: (format?: string) => KNOWN_TOPIC_XDR },
      { toXDR: (format?: string) => UNKNOWN_TOPIC_XDR },
    ],
    value: { toXDR: (format?: string) => VALID_DATA_XDR },
    ledger: 3000,
    txHash: "txhash_vector_001",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  };
}

/**
 * Summary of available fixtures for testing:
 *
 * - createKnownEventFixture(): Valid, decodable event → events table
 * - createUnknownTopicFixture(): Unknown topic → dead-letter, UnknownTopicError
 * - createMalformedTopicFixture(): Invalid XDR → dead-letter, DecodeError
 * - createMalformedDataFixture(): Invalid data → dead-letter, DecodeError
 * - createMixedEventBatch(): 6 events (mixed) → test pipeline resilience
 * - createBatchWithMostlyUnknownTopics(): 50 events (90% unknown) → scalability test
 * - createEventWithTopicVector(): Multi-element topic → test topic handling
 */
