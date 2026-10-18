import { Router, Request, Response } from "express";
import {
  dryRunRouterUpgrade,
  type RouterUpgradeDryRunInput,
} from "../services/routerUpgradeService";
import { sendError } from "../utils/errorResponse";

const router = Router();

/**
 * POST /api/router-upgrade/dry-run
 *
 * Performs a safe dry-run invocation of a candidate router contract before
 * committing an on-chain router upgrade. Verifies address format, ensures the
 * candidate differs from the active router, and simulates contract invocation
 * (calling the DEX router `swap` entrypoint) via Soroban RPC.
 *
 * Catches raw provider output and maps it to stable, typed error codes.
 */
router.post("/dry-run", async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body as Partial<RouterUpgradeDryRunInput>;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({
        error: "INVALID_REQUEST",
        message: "Request body must be a JSON object.",
      });
      return;
    }

    const input: RouterUpgradeDryRunInput = {
      candidateRouterAddress: String(body.candidateRouterAddress || ""),
      currentRouterAddress: body.currentRouterAddress ? String(body.currentRouterAddress) : undefined,
      targetContract: body.targetContract ? String(body.targetContract) : undefined,
      testTokenIn: body.testTokenIn ? String(body.testTokenIn) : undefined,
      testTokenOut: body.testTokenOut ? String(body.testTokenOut) : undefined,
      testAmountStroops: body.testAmountStroops ? String(body.testAmountStroops) : undefined,
      network: body.network,
      mockSimulate: body.mockSimulate,
    };

    const result = await dryRunRouterUpgrade(input);

    if (!result.success && result.error?.code === "EMPTY_ADDRESS") {
      res.status(400).json(result);
      return;
    }

    if (!result.success && result.error?.code === "INVALID_ADDRESS_FORMAT") {
      res.status(400).json(result);
      return;
    }

    if (!result.success && result.error?.code === "IDENTICAL_ROUTER") {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    sendError(
      res,
      500,
      "DRY_RUN_FAILED",
      "Failed to execute router upgrade dry-run.",
      error instanceof Error ? error.message : undefined
    );
  }
});

/**
 * GET /api/router-upgrade/status
 *
 * Returns current router address, environment configuration, and supported assets.
 */
router.get("/status", (_req: Request, res: Response): void => {
  try {
    const currentRouter = process.env.DEX_ROUTER_CONTRACT_ID || null;
    const rpcUrl = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
    const network = process.env.STELLAR_NETWORK || "testnet";

    res.json({
      activeRouterAddress: currentRouter,
      network,
      rpcConfigured: Boolean(rpcUrl),
      simSourceConfigured: Boolean(process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    sendError(
      res,
      500,
      "STATUS_UNAVAILABLE",
      "Failed to retrieve router configuration status.",
      error instanceof Error ? error.message : undefined
    );
  }
});

export default router;
