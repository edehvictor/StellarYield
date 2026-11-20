// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MarketSnapshot} from "./MarketSnapshot.sol";

/**
 * @dev Enforces bounded time skew and ledger coherence across the spot, perpetual, funding and hedge inputs of a delta-neutral rebalance.
 *
 * The guard is purely validational: it never mutates state. A failed check reverses with a dedicated error and leaves the caller's state untouched, which is the required boundary behavior for a rejected rebalance.
 */
contract RebalanceGuard {
    // --------------------------------------------------------------------------
    // Errors
    // --------------------------------------------------------------------------

    /** Thrown when a provided source identifier is zero. */
    error InvalidSourceIdentifier();

    /** Thrown when the snapshot ledger does not match the expected ledger. */
    error LedgerMismatch(bytes32 expected, bytes32 actual);

    /** Thrown when the snapshot timestamp is in the future relative to `now`. */
    error SnapshotInFuture(uint64 snapshotTimestamp, uint64 now);

    /** Thrown when the source timestamp is in the future relative to `now`. */
    error SourceInFuture(uint64 sourceTimestamp, uint64 now);

    /** Thrown when a source is older than the allowed maximum age. */
    error StaleSource(uint64 sourceTimestamp, uint64 now, uint64 maxAge);

    /** Thrown when two sources differ by more than the allowed skew. */
    error SkewExceeded(uint64 earlier, uint64 later, uint64 maxSkew);

    /** Thrown when the snapshot is stale relative to `now`. */
    error StaleSnapshot(uint64 snapshotTimestamp, uint64 now, uint64 maxAge);

    // --------------------------------------------------------------------------
    // Types
    // --------------------------------------------------------------------------

    /**
     * @dev Declarative bounds applied to a rebalance validation.
     * @note `All timestamps are Unix seconds and must be non-decreasing relative to `now`.
     */
    struct Bounds {
        /** Maximum age of any individual source relative to `now`. */
        uint64 maxSourceAge;
        /** Maximum age of the assembled snapshot relative to `now`. */
        uint64 maxSnapshotAge;
        /** Maximum absolute difference between any two source timestamps. */
        uint64 maxSkew;
    }

    /**
     * @dev Per-leg timestamps supplied by the caller for a rebalance.
     * @note The ledger identifier is not part of this struct; it is carried by the `MarketSnapshot` and checked against an expected value.
     */
    struct LegTimestamps {
        uint64 spot;
        uint64 perp;
        uint64 funding;
        uint64 hedge;
    }

    // --------------------------------------------------------------------------
    // Validation
    // --------------------------------------------------------------------------

    /**
     * @dev Validates that a snapshot and its per-leg timestamps are coherent with the supplied bounds and ledger.
     * @param snapshot The market snapshot whose ledger and timestamp are validated.
     * @param legs Per-leg timestamps for spot, perp, funding and hedge inputs.
     * @param expectedLedger The ledger the rebalance is expected to operate on.
     * @param bounds The time-skew and age bounds to enforce.
     * @param now The current timestamp as perceived by the caller.
     * @returns true if all checks pass. Reverts with a dedicated error otherwise.
     */
    function validate(
        MarketSnapshot snapshot,
        LegTimestamps calmostLegs,
        bytes32 expectedSpotFeed,
        bytes32 expectedPerpFeed,
        bytes32 expectedFundingFeed,
        bytes32 expectedHedgeFeed,
        bytes32 expectedLedger,
        Bounds callmostBounds,
        uint64 now
    ) external view returns (bool) {
        // Source identifiers must be non-zero and must match the snapshot.
        if (expectedSpotFeed == bytes32(0) || expectedPerpFeed == bytes32(0)
            || expectedFundingFeed == bytes32(0) || expectedHedgeFeed == bytes32(0)
            || expectedLedger == bytes32(0)
        ) {
            revert InvalidSourceIdentifier();
        }

        // Ledger coherence: the snapshot must belong to the expected ledger.
        bytes32 actualLedger = snapshot.ledgerId();
        if (actualLedger != expectedLedger) {
            revert LedgerMismatch(expectedLedger, actualLedger);
        }

        // The snapshot itself must not be from the future and must be within maxSnapshotAge.
        uint64 snapshotTimestamp = snapshot.timestamp();
        _requireNotFuture(snapshotTimestamp, now);
        _requireWithinAge(snapshotTimestamp, now, bounds.maxSnapshotAge, true);

        // Each leg must be within maxSourceAge and not from the future.
        _requireSourceBounds(legs.spot, now, bounds.maxSourceAge);
        _requireSourceBounds(legs.perp, now, bounds.maxSourceAge);
        _requireSourceBounds(legs.funding, now, bounds.maxSourceAge);
        _requireSourceBounds(legs.hedge, now, bounds.maxSourceAge);

        // Pairwise skew across all legs must remain within maxSkew.
        _requireSkewWithin(legs.spot, legs.perp, bounds.maxSkew);
        _requireSkewWithin(legs.spot, legs.funding, bounds.maxSkew);
        _requireSkewWithin(legs.spot, legs.hedge, bounds.maxSkew);
        _requireSkewWithin(legs.perp, legs.funding, bounds.maxSkew);
        _requireSkewWithin(legs.perp, legs.hedge, bounds.maxSkew);
        _requireSkewWithin(legs.funding, legs.hedge, bounds.maxSkew);

        // The snapshot timestamp must also sit within the leg skew window.
        _requireSkewWithin(snapshotTimestamp, legs.spot, bounds.maxSkew);
        _requireSkewWithin(snapshotTimestamp, legs.perp, bounds.maxSkew);
        _requireSkewWithin(snapshotTimestamp, legs.funding, bounds.maxSkew);
        _requireSkewWithin(snapshotTimestamp, legs.hedge, bounds.maxSkew);

        // Finally, the source identifiers carried by the snapshot must match the expected ones.
        if (snapshot.spotFeedId() != expectedSpotFeed) {
            revert InvalidSourceIdentifier();
        }
        if (snapshot.perpFeedId() != expectedPerpFeed) {
            revert InvalidSourceIdentifier();
        }
        if (snapshot.fundingFeedId() != expectedFundingFeed) {
            revert InvalidSourceIdentifier();
        }
        if (snapshot.hedgeFeedId() != expectedHedgeFeed) {
            revert InvalidSourceIdentifier();
        }

        return true;
    }

    // --------------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------------

    function _requireSourceBounds(uint64 sourceTimestamp, uint64 now, uint64 maxAge) private pure {
        _requireNotFuture(sourceTimestamp, now);
        _requireWithinAge(sourceTimestamp, now, maxAge, false);
    }

    function _requireNotFuture(uint64 timestamp, uint64 now) private pure {
        if (timestamp > now) {
            revert SourceInFuture(timestamp, now);
        }
    }

    function _requireWithinAge(uint64 timestamp, uint64 now, uint64 maxAge, bool isSnapshot) private pure {
        // `now >= timestamp` is guaranteed by the future check above.
        uint64 age = now - timestamp;
        if (age > maxAge) {
            if (isSnapshot) {
                revert StaleSnapshot(timestamp, now, maxAge);
            }
            revert StaleSource(timestamp, now, maxAge);
        }
    }

    function _requireSkewWithin(uint64 a, uint64 b, uint64 maxSkew) private pure {
        uint64 earlier = a < b ? a : b;
        uint64 later = a < b ? b : a;
        if (later - earlier > maxSkew) {
            revert SkewExceeded(earlier, later, maxSkew);
        }
    }
}
