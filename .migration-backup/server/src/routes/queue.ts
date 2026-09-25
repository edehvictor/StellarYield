import { Router, Request, Response } from "express";
import { strategyCandidateQueueService, type StrategyCandidate } from "../services/strategyCandidateQueueService";

const router = Router();

/**
 * POST /api/queue/candidate/enqueue
 * Enqueue a strategy candidate for prioritization.
 */
router.post("/candidate/enqueue", (req: Request, res: Response) => {
  try {
    const candidate = req.body as StrategyCandidate;

    if (!candidate.id || !candidate.name || !candidate.strategyType) {
      res.status(400).json({ error: "Candidate must have id, name, and strategyType" });
      return;
    }

    const qualified = strategyCandidateQueueService.isCandidateQualified(candidate);
    const added = strategyCandidateQueueService.enqueue(candidate);

    res.json({
      success: true,
      data: {
        added,
        qualified,
        candidateId: candidate.id,
        queueSize: strategyCandidateQueueService.getQueueState().currentQueueSize,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to enqueue candidate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/queue/candidate/next
 * Get the next candidate for processing.
 */
router.get("/candidate/next", (_req: Request, res: Response) => {
  try {
    const next = strategyCandidateQueueService.nextForProcessing();
    res.json({ success: true, data: next });
  } catch (error) {
    res.status(500).json({
      error: "Failed to get next candidate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/queue/candidate/prioritized
 * Get the full prioritized queue.
 */
router.get("/candidate/prioritized", (_req: Request, res: Response) => {
  try {
    const queue = strategyCandidateQueueService.getPrioritizedQueue();
    const state = strategyCandidateQueueService.getQueueState();
    res.json({ success: true, data: { queue, state } });
  } catch (error) {
    res.status(500).json({
      error: "Failed to get prioritized queue",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/queue/candidate/:candidateId/approve
 * Approve a candidate for processing.
 */
router.post("/candidate/:candidateId/approve", (req: Request, res: Response) => {
  try {
    const { candidateId } = req.params;
    const result = strategyCandidateQueueService.approve(candidateId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      error: "Failed to approve candidate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/queue/candidate/:candidateId/reject
 * Reject a candidate with a reason.
 */
router.post("/candidate/:candidateId/reject", (req: Request, res: Response) => {
  try {
    const { candidateId } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!reason) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    const result = strategyCandidateQueueService.reject(candidateId, reason);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      error: "Failed to reject candidate",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/queue/state
 * Get current queue state.
 */
router.get("/state", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: strategyCandidateQueueService.getQueueState(),
  });
});

/**
 * GET /api/queue/config
 * Get queue configuration.
 */
router.get("/config", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: strategyCandidateQueueService.getConfig(),
  });
});

/**
 * POST /api/queue/config
 * Update queue configuration.
 */
router.post("/config", (req: Request, res: Response) => {
  try {
    const config = req.body;
    strategyCandidateQueueService.updateConfig(config);
    res.json({
      success: true,
      data: strategyCandidateQueueService.getConfig(),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to update queue config",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/queue/clear
 * Clear all candidates from the queue.
 */
router.post("/clear", (_req: Request, res: Response) => {
  strategyCandidateQueueService.clear();
  res.json({ success: true, message: "Queue cleared" });
});

export default router;
