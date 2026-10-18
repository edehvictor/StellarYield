/**
 * User preference audit routes (#1311)
 *
 * GET /api/preferences/audit/:walletAddress
 * Returns the backend audit trail of preference changes for a wallet
 * (digest preferences, digest schedule, notification preferences).
 * Optional `?category=` filters by preference category.
 */

import { Router, Request, Response } from "express";
import { validateWalletAddress } from "../middleware/validation";
import { sendError } from "../utils/errorResponse";
import {
  getUserPreferenceAuditHistory,
  type PreferenceCategory,
} from "../services/userPreferenceAuditService";
import {
  getPreferenceAuditHistory as getAlertPreferenceAuditHistory,
} from "../services/alertPreferenceAuditService";

const router = Router();

const VALID_CATEGORIES: PreferenceCategory[] = [
  "digest_preference",
  "digest_schedule",
  "notification_preference",
  "other",
];

router.get(
  "/audit/:walletAddress",
  validateWalletAddress,
  (req: Request, res: Response) => {
    const { walletAddress } = req.params;
    const rawCategory = req.query.category;

    if (rawCategory !== undefined) {
      const category = String(rawCategory);
      if (!VALID_CATEGORIES.includes(category as PreferenceCategory)) {
        sendError(
          res,
          400,
          "INVALID_CATEGORY",
          `category must be one of: ${VALID_CATEGORIES.join(", ")}.`,
        );
        return;
      }
      const history = getUserPreferenceAuditHistory(
        walletAddress,
        category as PreferenceCategory,
      );
      res.json({ walletAddress, category, history });
      return;
    }

    const history = getUserPreferenceAuditHistory(walletAddress);
    res.json({ walletAddress, history });
  },
);

/**
 * GET /api/preferences/audit/:walletAddress/alerts
 * Vault-scoped alert preference audit history (delegates to the existing
 * alertPreferenceAuditService used by /api/alerts).
 */
router.get(
  "/audit/:walletAddress/alerts",
  validateWalletAddress,
  (req: Request, res: Response) => {
    const { walletAddress } = req.params;
    const { vaultId } = req.query as { vaultId?: string };

    if (!vaultId) {
      sendError(res, 400, "MISSING_VAULT_ID", "vaultId query parameter is required.");
      return;
    }

    const history = getAlertPreferenceAuditHistory(walletAddress, vaultId);
    res.json({ walletAddress, vaultId, history });
  },
);

export default router;
