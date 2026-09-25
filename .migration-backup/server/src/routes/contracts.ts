/**
 * Contract-level routes (#1296).
 *
 * Currently exposes deployment-manifest verification, which mirrors the
 * contract-side verify-manifest.js pipeline (provenance → schema conformance →
 * drift) with typed, deterministic results.
 */

import { Router, Request, Response } from "express";
import { successEnvelope, errorEnvelope } from "../types/envelope";
import {
  buildDeploymentManifestVerification,
  DeploymentManifestError,
} from "../services/deploymentManifestService";

const router = Router();

/**
 * GET /api/contracts/deployment-manifest/verify?network=testnet
 * Deterministically verify the deployment manifest against the contract
 * registry for a network. Results are stable across identical inputs.
 */
router.get(
  "/deployment-manifest/verify",
  (req: Request, res: Response) => {
    try {
      const network = req.query.network ?? "testnet";
      const verification = buildDeploymentManifestVerification(
        network as string,
      );
      res
        .status(200)
        .json(successEnvelope(verification, "contracts/deployment-manifest/verify"));
    } catch (err) {
      if (err instanceof DeploymentManifestError) {
        res
          .status(err.statusCode)
          .json(
            errorEnvelope(
              err.code,
              err.message,
              "contracts/deployment-manifest/verify",
              err.details,
            ),
          );
        return;
      }
      res
        .status(500)
        .json(
          errorEnvelope(
            "INTERNAL_ERROR",
            "Failed to verify deployment manifest",
            "contracts/deployment-manifest/verify",
          ),
        );
    }
  },
);

export default router;