/**
 * Governance Vote Receipt Routes (#1190)
 *
 * Exposes endpoints for submitting and querying governance vote receipts.
 * The reconcile endpoint is used by the indexer poller to update receipt
 * statuses once on-chain events are confirmed.
 */
import { Router, Request, Response } from "express";
import { idempotency, IDEMPOTENT_REPLAYED_HEADER } from "../middleware/idempotency";
import {
  submitVoteReceiptOnce,
  reconcileVoteReceipts,
  getVoteReceipt,
  listVoteReceipts,
  type IndexedGovernanceEvent,
} from "../services/governanceVoteReceiptService";
import { sendError } from "../utils/errorResponse";

const router = Router();

/**
 * POST /api/governance/vote-receipts
 * Submit a new governance vote and receive a pending receipt.
 *
 * Body: { proposalId: string, voter: string, choice: string }
 *
 * A vote is identified by (proposalId, voter), so a retry can never record it
 * twice, with or without an `Idempotency-Key`:
 *   first submission                       → 201 and a pending receipt
 *   retry, same choice                     → 200, the same receipt, `Idempotent-Replayed: true`
 *   different choice, vote already pending
 *   or recorded                            → 409 VOTE_ALREADY_SUBMITTED, nothing changes
 *   resubmission after the receipt failed  → 201 and a new receipt
 */
router.post(
  "/vote-receipts",
  idempotency({ scope: "governance.vote-receipts" }),
  (req: Request, res: Response) => {
  const { proposalId, voter, choice } = req.body as {
    proposalId?: string;
    voter?: string;
    choice?: string;
  };

  if (!proposalId || typeof proposalId !== "string") {
    sendError(res, 400, "MISSING_PROPOSAL_ID", "proposalId is required.");
    return;
  }
  if (!voter || typeof voter !== "string") {
    sendError(res, 400, "MISSING_VOTER", "voter (Stellar account address) is required.");
    return;
  }
  if (!choice || typeof choice !== "string") {
    sendError(res, 400, "MISSING_CHOICE", "choice is required (e.g. yes, no, abstain).");
    return;
  }

  const { outcome, receipt } = submitVoteReceiptOnce(proposalId, voter, choice);
  if (outcome === "conflict") {
    sendError(
      res,
      409,
      "VOTE_ALREADY_SUBMITTED",
      "This voter already has a vote in flight or recorded for this proposal with a different choice. The existing receipt was not changed.",
      { receiptId: receipt.receiptId, choice: receipt.choice, status: receipt.status },
    );
    return;
  }
  if (outcome === "replayed") {
    res.set(IDEMPOTENT_REPLAYED_HEADER, "true");
    res.status(200).json(receipt);
    return;
  }
  res.status(201).json(receipt);
});

/**
 * GET /api/governance/vote-receipts/:receiptId
 * Retrieve a single vote receipt and its current reconciliation status.
 */
router.get("/vote-receipts/:receiptId", (req: Request, res: Response) => {
  const { receiptId } = req.params;
  const receipt = getVoteReceipt(receiptId);

  if (!receipt) {
    sendError(res, 404, "RECEIPT_NOT_FOUND", "No vote receipt found for the given ID.");
    return;
  }

  res.json(receipt);
});

/**
 * GET /api/governance/vote-receipts
 * List receipts for a proposal. Query params: proposalId (required), voter (optional).
 */
router.get("/vote-receipts", (req: Request, res: Response) => {
  const { proposalId, voter } = req.query as { proposalId?: string; voter?: string };

  if (!proposalId) {
    sendError(res, 400, "MISSING_PROPOSAL_ID", "proposalId query parameter is required.");
    return;
  }

  const receipts = listVoteReceipts(proposalId, voter);
  res.json({ proposalId, receipts });
});

/**
 * POST /api/governance/vote-receipts/reconcile
 * Internal endpoint called by the indexer to push a batch of confirmed
 * on-chain governance events and update receipt statuses.
 *
 * Body: { events: IndexedGovernanceEvent[] }
 */
router.post("/vote-receipts/reconcile", (req: Request, res: Response) => {
  const { events } = req.body as { events?: unknown };

  if (!Array.isArray(events)) {
    sendError(res, 400, "INVALID_EVENTS", "events must be an array of indexed governance events.");
    return;
  }

  // Basic shape validation
  const valid = (events as IndexedGovernanceEvent[]).every(
    (e) =>
      typeof e.proposalId === "string" &&
      typeof e.voter === "string" &&
      typeof e.choice === "string" &&
      typeof e.txHash === "string" &&
      typeof e.indexedAt === "string",
  );

  if (!valid) {
    sendError(
      res,
      400,
      "INVALID_EVENT_SHAPE",
      "Each event must have proposalId, voter, choice, txHash, and indexedAt.",
    );
    return;
  }

  const updated = reconcileVoteReceipts(events as IndexedGovernanceEvent[]);
  res.json({ reconciled: updated.length, receipts: updated });
});

export default router;
