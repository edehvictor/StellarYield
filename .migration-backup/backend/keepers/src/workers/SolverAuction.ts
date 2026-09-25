import { logger } from '../utils/logger';
import crypto from 'crypto';

/**
 * Represents a solver bid in the commit phase.
 */
export interface SolverBid {
    solverId: string;
    /** Commit hash: keccak256(reveal_data) */
    commitHash: string;
    /** Timestamp of commitment */
    committedAt: string;
    /** Nonce for uniqueness */
    nonce: string;
}

/**
 * Revealed solver bid data.
 */
export interface RevealedBid {
    solverId: string;
    /** Output amount (best route result) */
    outputAmount: string;
    /** Fees charged by solver */
    fees: string;
    /** Execution latency in ms */
    latency: number;
    /** Risk score (0-1, lower is better) */
    riskScore: number;
    /** Route path encoding */
    routePath: string;
    /** Timestamp of reveal */
    revealedAt: string;
}

/**
 * Scored bid after evaluation.
 */
export interface ScoredBid extends RevealedBid {
    commitHash: string;
    /** Composite score (0-1, higher is better) */
    compositeScore: number;
    /** Breakdown of score components */
    scoreBreakdown: {
        outputScore: number;
        feeScore: number;
        latencyScore: number;
        riskScore: number;
    };
}

/**
 * Result of the solver auction.
 */
export interface AuctionResult {
    vaultId: string;
    selectedSolverId: string;
    selectedRoute: string;
    selectedBid: ScoredBid;
    alternativeRoutes: ScoredBid[];
    auctionId: string;
    totalBids: number;
    selectedAt: string;
    evidence: string;
    tieBreaker?: string;
}

/**
 * Solver Auction Manager
 *
 * Implements a commit-reveal auction for vault rebalance route selection.
 * Phases:
 * 1. Commit: Solvers submit commitment hashes
 * 2. Reveal: Solvers reveal actual bids
 * 3. Score: Bids evaluated on output, fees, latency, risk
 * 4. Select: Deterministic tie-breaking selects winner
 * 5. Settle: Winner's route is used for execution
 */
export class SolverAuction {
    private commits: Map<string, SolverBid> = new Map();
    private reveals: Map<string, RevealedBid> = new Map();
    private readonly revealWindow = 300000; // 5 minutes
    private readonly commitWindow = 60000; // 1 minute

    /**
     * Phase 1: Receive commitment from solver.
     * Solver submits hash without revealing actual bid.
     *
     * @param solverId - Solver identifier
     * @param commitHash - keccak256 hash of reveal data
     * @param nonce - Unique nonce for this auction
     */
    submitCommit(solverId: string, commitHash: string, nonce: string): void {
        if (this.commits.has(solverId)) {
            throw new Error(`Solver ${solverId} already committed`);
        }

        this.commits.set(solverId, {
            solverId,
            commitHash,
            committedAt: new Date().toISOString(),
            nonce,
        });

        logger.debug({ solverId, commitHash }, '[SolverAuction] Commit received');
    }

    /**
     * Phase 2: Reveal actual bid.
     * Solver submits bid data and proof.
     * Validates commitment match.
     *
     * @param solverId - Solver identifier
     * @param bid - Revealed bid data
     */
    submitReveal(solverId: string, bid: RevealedBid): void {
        const commit = this.commits.get(solverId);
        if (!commit) {
            throw new Error(`No commit found for solver ${solverId}`);
        }

        // Verify reveal matches commitment
        const revealHash = this.computeCommitHash(bid, commit.nonce);
        if (revealHash !== commit.commitHash) {
            logger.warn(
                { solverId, expected: commit.commitHash, got: revealHash },
                '[SolverAuction] Reveal validation failed (mismatch)',
            );
            throw new Error('Reveal does not match commitment');
        }

        // Check reveal is within window
        const commitTime = new Date(commit.committedAt).getTime();
        const revealTime = new Date().getTime();
        if (revealTime - commitTime > this.revealWindow) {
            throw new Error('Reveal window expired');
        }

        this.reveals.set(solverId, bid);
        logger.debug(
            { solverId, outputAmount: bid.outputAmount },
            '[SolverAuction] Reveal accepted',
        );
    }

    /**
     * Phase 3: Score all reveals.
     * Computes composite score for each bid:
     * - Output maximization (40%)
     * - Fee minimization (30%)
     * - Latency (20%)
     * - Risk mitigation (10%)
     *
     * @param baseBenchmark - Baseline output for scoring (if no reveals, scored 0)
     */
    scoreReveals(baseBenchmark?: string): ScoredBid[] {
        if (this.reveals.size === 0) {
            logger.warn('[SolverAuction] No reveals to score');
            return [];
        }

        const revealed = Array.from(this.reveals.values());
        const scored: ScoredBid[] = [];

        // Find normalization values
        const maxOutput = BigInt(
            Math.max(...revealed.map((b) => BigInt(b.outputAmount)), 0n),
        );
        const minFees = BigInt(
            Math.min(...revealed.map((b) => BigInt(b.fees)), BigInt('9999999999999999999')),
        );
        const maxLatency = Math.max(...revealed.map((b) => b.latency), 1);
        const maxRisk = Math.max(...revealed.map((b) => b.riskScore), 1);

        for (const reveal of revealed) {
            const commit = this.commits.get(reveal.solverId)!;

            // Score components (0-1 range)
            const outputScore =
                maxOutput > 0n
                    ? Number((BigInt(reveal.outputAmount) * 100n) / maxOutput) / 100
                    : 0;
            const feeScore = Math.max(
                0,
                1 - Number((BigInt(reveal.fees) * 100n) / (minFees > 0n ? minFees : 1n)) / 100,
            );
            const latencyScore = Math.max(0, 1 - reveal.latency / maxLatency);
            const riskScore = Math.max(0, 1 - reveal.riskScore / maxRisk);

            // Composite score: weighted sum
            const compositeScore =
                outputScore * 0.4 +
                feeScore * 0.3 +
                latencyScore * 0.2 +
                riskScore * 0.1;

            scored.push({
                ...reveal,
                commitHash: commit.commitHash,
                compositeScore,
                scoreBreakdown: {
                    outputScore,
                    feeScore,
                    latencyScore,
                    riskScore,
                },
            });
        }

        // Sort by score (descending)
        scored.sort((a, b) => b.compositeScore - a.compositeScore);

        logger.info(
            { count: scored.length, topScore: scored[0]?.compositeScore },
            '[SolverAuction] Reveals scored',
        );

        return scored;
    }

    /**
     * Phase 4: Select winner with deterministic tie-breaking.
     * Uses solverId hash for determinism.
     *
     * @param vaultId - Vault being rebalanced
     * @param scored - Scored bids (from scoreReveals)
     */
    selectWinner(vaultId: string, scored: ScoredBid[]): AuctionResult {
        if (scored.length === 0) {
            throw new Error('No scored bids to select from');
        }

        // Find bids with same top score (ties)
        const topScore = scored[0].compositeScore;
        const topBids = scored.filter((b) => b.compositeScore === topScore);

        let selectedBid = topBids[0];
        let tieBreaker: string | undefined;

        if (topBids.length > 1) {
            // Tie: use deterministic ordering by solverId hash
            topBids.sort((a, b) => {
                const hashA = crypto
                    .createHash('sha256')
                    .update(a.solverId + vaultId)
                    .digest('hex');
                const hashB = crypto
                    .createHash('sha256')
                    .update(b.solverId + vaultId)
                    .digest('hex');
                return hashA.localeCompare(hashB);
            });
            selectedBid = topBids[0];
            tieBreaker = `Deterministic: ${topBids.length} solvers tied at score ${topScore}`;
        }

        const auctionId = crypto
            .createHash('sha256')
            .update(vaultId + new Date().toISOString())
            .digest('hex')
            .slice(0, 16);

        const result: AuctionResult = {
            vaultId,
            selectedSolverId: selectedBid.solverId,
            selectedRoute: selectedBid.routePath,
            selectedBid,
            alternativeRoutes: scored.slice(1),
            auctionId,
            totalBids: scored.length,
            selectedAt: new Date().toISOString(),
            evidence: `Selected solver: ${selectedBid.solverId}, Score: ${selectedBid.compositeScore.toFixed(3)}, Breakdown: output=${selectedBid.scoreBreakdown.outputScore.toFixed(2)} fee=${selectedBid.scoreBreakdown.feeScore.toFixed(2)} latency=${selectedBid.scoreBreakdown.latencyScore.toFixed(2)} risk=${selectedBid.scoreBreakdown.riskScore.toFixed(2)}`,
            tieBreaker,
        };

        logger.info(
            {
                vaultId,
                selectedSolver: result.selectedSolverId,
                auctionId,
                totalBids: result.totalBids,
            },
            '[SolverAuction] Winner selected',
        );

        return result;
    }

    /**
     * Validate that all reveals match their commitments.
     * Returns list of invalid solvers.
     *
     * @returns List of solvers with invalid reveals
     */
    validateReveals(): string[] {
        const invalid: string[] = [];

        for (const [solverId, reveal] of this.reveals.entries()) {
            const commit = this.commits.get(solverId);
            if (!commit) {
                invalid.push(solverId);
                continue;
            }

            const revealHash = this.computeCommitHash(reveal, commit.nonce);
            if (revealHash !== commit.commitHash) {
                invalid.push(solverId);
            }
        }

        if (invalid.length > 0) {
            logger.warn({ invalid }, '[SolverAuction] Invalid reveals detected');
        }

        return invalid;
    }

    /**
     * Slash invalid solvers or reject their bids.
     * Implementation-dependent: may record for slashing contract or audit.
     *
     * @param solverId - Solver to slash
     * @param reason - Reason for slash
     */
    slashSolver(solverId: string, reason: string): void {
        logger.warn(
            { solverId, reason },
            '[SolverAuction] Solver slashed for invalid reveal',
        );
        // TODO: Implement slashing (record for contract or audit trail)
        // For now: audit trail via logger
    }

    /**
     * Compute commit hash for reveal data.
     * Uses SHA256 for consistency.
     *
     * @param reveal - Revealed bid data
     * @param nonce - Nonce from commit
     */
    private computeCommitHash(reveal: RevealedBid, nonce: string): string {
        const data = JSON.stringify({
            outputAmount: reveal.outputAmount,
            fees: reveal.fees,
            latency: reveal.latency,
            riskScore: reveal.riskScore,
            routePath: reveal.routePath,
            nonce,
        });
        return crypto.createHash('sha256').update(data).digest('hex');
    }

    /**
     * Reset auction state (for testing or new round).
     */
    reset(): void {
        this.commits.clear();
        this.reveals.clear();
    }

    /**
     * Get current state (for debugging).
     */
    getState() {
        return {
            commits: this.commits.size,
            reveals: this.reveals.size,
            revealWindow: this.revealWindow,
            commitWindow: this.commitWindow,
        };
    }
}
