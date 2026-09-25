import { Router } from "express";
import { sendError } from "../utils/errorResponse";
import {
  yieldReliabilityEngine,
  formatReliabilityScore,
} from "../services/yieldReliabilityService";

const reliabilityRouter = Router();

/**
 * GET /api/reliability
 * Returns reliability scores for all known data providers.
 */
reliabilityRouter.get("/", async (_req, res) => {
  try {
    const providers = await yieldReliabilityEngine.getReliabilityScores([
      { id: "blend_api", name: "Blend Protocol", source: "api" },
      { id: "soroswap_api", name: "Soroswap", source: "api" },
      { id: "defindex_api", name: "DeFindex", source: "api" },
      { id: "stellar_expert", name: "Stellar Expert", source: "oracle" },
      { id: "coingecko", name: "CoinGecko", source: "oracle" },
    ]);

    res.json(providers.map(formatReliabilityScore));
  } catch (error) {
    console.error("Failed to serve /api/reliability.", error);
    sendError(
      res,
      500,
      "RELIABILITY_FETCH_FAILED",
      "Unable to fetch reliability data right now.",
    );
  }
});

/**
 * GET /api/reliability/:providerId
 * Returns reliability score for a single provider.
 */
reliabilityRouter.get("/:providerId", async (req, res) => {
  try {
    const { providerId } = req.params;

    const knownProviders: Record<string, { name: string; source: string }> = {
      blend_api: { name: "Blend Protocol", source: "api" },
      soroswap_api: { name: "Soroswap", source: "api" },
      defindex_api: { name: "DeFindex", source: "api" },
      stellar_expert: { name: "Stellar Expert", source: "oracle" },
      coingecko: { name: "CoinGecko", source: "oracle" },
    };

    const provider = knownProviders[providerId];
    if (!provider) {
      sendError(res, 404, "PROVIDER_NOT_FOUND", `Unknown provider: ${providerId}`);
      return;
    }

    const reliability = await yieldReliabilityEngine.calculateReliabilityScore(
      providerId,
      provider.name,
      provider.source,
    );

    res.json(formatReliabilityScore(reliability));
  } catch (error) {
    console.error(`Failed to serve reliability for ${req.params.providerId}.`, error);
    sendError(
      res,
      500,
      "RELIABILITY_FETCH_FAILED",
      "Unable to fetch provider reliability right now.",
    );
  }
});

/**
 * GET /api/reliability/uptime/all
 * Returns uptime reports for all providers.
 */
reliabilityRouter.get("/uptime/all", async (_req, res) => {
  try {
    const reports = await yieldReliabilityEngine.getAllProviderUptimeReports();
    res.json(reports);
  } catch (error) {
    console.error("Failed to serve /api/reliability/uptime/all.", error);
    sendError(
      res,
      500,
      "UPTIME_FETCH_FAILED",
      "Unable to fetch uptime reports right now.",
    );
  }
});

export default reliabilityRouter;
