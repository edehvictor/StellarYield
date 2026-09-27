/**
 * Portfolio exposure heatmap route.
 *
 * POST /api/portfolio/exposure/heatmap
 *   Body: { positions: [{ asset, protocol, valueUsd }], maxAssets?, maxProtocols? }
 *   `currentValueUsd` is accepted in place of `valueUsd` so callers holding the
 *   server's `VaultPosition` shape can post it unchanged.
 *
 * Returns the asset × protocol matrix built by the shared `buildExposureHeatmap`,
 * graded with this deployment's concentration thresholds. Invalid input maps
 * to a 400 with the builder's error code; the handler never inspects messages.
 */

import { Router, Request, Response } from "express";
import { sendError } from "../utils/errorResponse";
import { readConcentrationThresholdOverrides } from "../config/concentrationThresholds";
import {
  buildExposureHeatmap,
  ExposureHeatmapError,
} from "../../../shared/types/exposureHeatmap";

/** Map `currentValueUsd` onto `valueUsd` when only the former is present. */
function normalizePosition(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const p = raw as Record<string, unknown>;
  if (p.valueUsd === undefined && p.currentValueUsd !== undefined) {
    return { ...p, valueUsd: p.currentValueUsd };
  }
  return p;
}

function optionalInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : null;
}

export function createPortfolioExposureRouter(): ReturnType<typeof Router> {
  const router = Router();

  router.post("/heatmap", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!Array.isArray(body.positions)) {
      return sendError(
        res,
        400,
        "MALFORMED_INPUT",
        "Request body must include an array of `positions`.",
      );
    }

    const maxAssets = optionalInteger(body.maxAssets);
    const maxProtocols = optionalInteger(body.maxProtocols);
    if (maxAssets === null || maxProtocols === null) {
      return sendError(
        res,
        400,
        "INVALID_OPTIONS",
        "`maxAssets` and `maxProtocols` must be numbers when provided.",
      );
    }

    try {
      const heatmap = buildExposureHeatmap(body.positions.map(normalizePosition), {
        thresholds: readConcentrationThresholdOverrides(),
        maxAssets,
        maxProtocols,
      });
      return res.json(heatmap);
    } catch (error) {
      if (error instanceof ExposureHeatmapError) {
        return sendError(
          res,
          400,
          error.code,
          error.message,
          error.index !== undefined ? { index: error.index } : undefined,
        );
      }
      return sendError(
        res,
        500,
        "EXPOSURE_HEATMAP_FAILED",
        "Unable to build the exposure heatmap at this time.",
      );
    }
  });

  return router;
}

export default createPortfolioExposureRouter();
