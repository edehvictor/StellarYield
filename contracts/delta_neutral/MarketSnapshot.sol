// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IMarketSnapshot} from "./interfaces/IMarketSnapshot.sol";

/**
 * @dev A coherent, immutable market snapshot for a delta-neutral strategy.
 *
 * A snapshot bundles the spot, perpetual, funding and hedge inputs together with the canonical ledger identifier and the timestamp at which the bundle was assembled.
 * The bundle is immutable once created, so consumers can rely on its internal coherence without reinterpreting individual legs.
 */
contract MarketSnapshot is IMarketSnapshot {
    bytes32 private immutable _spotFeedId;
    bytes32 private immutable _perpFeedId;
    bytes32 private immutable _fundingFeedId;
    bytes32 private immutable _hedgeFeedId;
    bytes32 private immutable _ledgerId;

    uint64 private immutable _timestamp;
    uint256 private immutable _spotPrice;
    uint256 private immutable _perpPrice;
    int256 private immutable _fundingRate;
    uint256 private immutable _hedgePrice;

    constructor(
        bytes32 spotFeedId_,
        bytes32 perpFeedId_,
        bytes32 fundingFeedId_,
        bytes32 hedgeFeedId_,
        bytes32 ledgerId_,
        uint64 timestamp_,
        uint256 spotPrice_,
        uint256 perpPrice_,
        int256 fundingRate_,
        uint256 hedgePrice_
    ) {
        require(spotFeedId_ != bytes32(0, "MarketSnapshot: zero spot feed");
        require(perpFeedId_ != bytes32(0, "MarketSnapshot: zero perp feed");
        require(fundingFeedId_ != bytes32(0, "MarketSnapshot: zero funding feed"));
        require(hedgeFeedId_ != bytes32(0, "MarketSnapshot: zero hedge feed"));
        require(ledgerId_ != bytes32(0, "MarketSnapshot: zero ledger"));
        require(timestamp_ != 0, "MarketSnapshot: zero timestamp");
        require(spotPrice_ != 0, "MarketSnapshot: zero spot price");
        require(perpPrice_ != 0, "MarketSnapshot: zero perp price");
        require(hedgePrice_ != 0, "MarketSnapshot: zero hedge price");

        _spotFeedId = spotFeedId_;
        _perpFeedId = perpFeedId_;
        _fundingFeedId = fundingFeedId_;
        _hedgeFeedId = hedgeFeedId_;
        _ledgerId = ledgerId_;
        _timestamp = timestamp_;
        _spotPrice = spotPrice_;
        _perpPrice = perpPrice_;
        _fundingRate = fundingRate_;
        _hedgePrice = hedgePrice_;
    }

    /** @inheritdoc IMarketSnapshot.spotFeedId */
    function spotFeedId() external view override returns (bytes32) {
        return _spotFeedId;
    }

    /** @inheritdoc IMarketSnapshot.perpFeedId */
    function perpFeedId() external view override returns (bytes32) {
        return _perpFeedId;
    }

    /** @inheritdoc IMarketSnapshot.fundingFeedId */
    function fundingFeedId() external view override returns (bytes32) {
        return _fundingFeedId;
    }

    /** @inheritdoc IMarketSnapshot.hedgeFeedId */
    function hedgeFeedId() external view override returns (bytes32) {
        return _hedgeFeedId;
    }

    /** @inheritdoc IMarketSnapshot.ledgerId */
    function ledgerId() external view override returns (bytes32) {
        return _ledgerId;
    }

    /** @returns the Unix timestamp at which this snapshot was assembled. */
    function timestamp() external view returns (uint64) {
        return _timestamp;
    }

    /** @returns the spot price captured in this snapshot. */
    function spotPrice() external view returns (uint256) {
        return _spotPrice;
    }

    /** @returns the perpetual price captured in this snapshot. */
    function perpPrice() external view returns (uint256) {
        return _perpPrice;
    }

    /** @returns the funding rate captured in this snapshot. */
    function fundingRate() external view returns (int256) {
        return _fundingRate;
    }

    /** @returns the hedge price captured in this snapshot. */
    function hedgePrice() external view returns (uint256) {
        return _hedgePrice;
    }
}
