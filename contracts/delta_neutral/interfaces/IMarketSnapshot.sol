// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Market source identifiers used to bind a snapshot to a specific venue and ledger.
 */
interface IMarketSnapshot {
    /** @identifies the spot market feed (e.g. a spot pool or oracle). */
    function spotFeedId() external view returns (bytes32);

    /** @identifies the perpetual market feed. */
    function perpFeedId() external view returns (bytes32);

    /** @identifies the funding rate source. */
    function fundingFeedId() external view returns (bytes32);

    /** @identifies the hedge instrument feed (e.g. a futures or synthetic leg). */
    function hedgeFeedId() external view returns (bytes32);

    /** @returns the canonical ledger identifier for this snapshot. */
    function ledgerId() external view returns (bytes32);
}
