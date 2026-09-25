/**
 * API route for vault migration readiness checklists (#1293).
 *
 * GET /api/vaults/migration-readiness/:slug
 *   Returns a deterministic typed checklist evaluating contract, server, and
 *   client readiness for migrating a vault. Unknown slugs and internal errors
 *   are returned as typed error envelopes.
 */

import { Router, Request, Response } from "express";
import {
  buildVaultMigrationReadiness,
  VaultMigrationReadinessError,
} from "../services/vaultMigrationReadinessService";
import { successEnvelope, errorEnvelope } from "../types/envelope";

const router = Router();

router.get("/:slug", async (req: Request, res: Response) => {
  try {
    const report = await buildVaultMigrationReadiness(req.params.slug);
    const warnings =
      report.network === "local"
        ? [
            `Network resolved to "local" from the runtime environment; confirm the operator selected the intended target network.`,
          ]
        : undefined;
    res.json(successEnvelope(report, "vaults/migration-readiness", warnings));
  } catch (err) {
    if (err instanceof VaultMigrationReadinessError) {
      res
        .status(err.statusCode)
        .json(
          errorEnvelope(
            err.code,
            err.message,
            "vaults/migration-readiness",
          ),
        );
      return;
    }
    console.error("Failed to build migration readiness checklist:", err);
    res.status(500).json(
      errorEnvelope(
        "INTERNAL_ERROR",
        "Failed to build migration readiness checklist",
        "vaults/migration-readiness",
      ),
    );
  }
});

export default router;