/**
 * Notification category preference routes (issue #1398).
 *
 * GET  /notifications/category-preferences/:walletAddress
 *   Returns all category preferences for the wallet.
 *
 * GET  /notifications/category-preferences/:walletAddress/:category
 *   Returns preferences for one alert category.
 *
 * PUT  /notifications/category-preferences/:walletAddress/:category
 *   Updates preferences for one alert category. Partial update — only the
 *   supplied fields are changed.
 *
 * DELETE /notifications/category-preferences/:walletAddress
 *   Resets all category preferences to defaults.
 */

import { Router, Request, Response } from "express";
import { validateWalletAddress } from "../middleware/validation";
import { sendError } from "../utils/errorResponse";
import {
  ALERT_CATEGORIES,
  getAllCategoryPreferences,
  getCategoryPreference,
  updateCategoryPreference,
  resetCategoryPreferences,
  validateCategoryPreferenceUpdate,
  type AlertCategory,
  type CategoryPreferenceUpdate,
} from "../services/notificationCategoryPreferences";

const router = Router();

const CATEGORY_SET = new Set<string>(ALERT_CATEGORIES);

function parseCategory(raw: string, res: Response): AlertCategory | null {
  const upper = raw.toUpperCase();
  if (!CATEGORY_SET.has(upper)) {
    sendError(
      res,
      400,
      "INVALID_CATEGORY",
      `category must be one of: ${ALERT_CATEGORIES.join(", ")}.`,
    );
    return null;
  }
  return upper as AlertCategory;
}

// GET /notifications/category-preferences/:walletAddress
router.get(
  "/category-preferences/:walletAddress",
  validateWalletAddress,
  (req: Request, res: Response) => {
    const { walletAddress } = req.params;
    res.json(getAllCategoryPreferences(walletAddress));
  },
);

// GET /notifications/category-preferences/:walletAddress/:category
router.get(
  "/category-preferences/:walletAddress/:category",
  validateWalletAddress,
  (req: Request, res: Response) => {
    const { walletAddress, category } = req.params;
    const cat = parseCategory(category, res);
    if (!cat) return;
    res.json(getCategoryPreference(walletAddress, cat));
  },
);

// PUT /notifications/category-preferences/:walletAddress/:category
router.put(
  "/category-preferences/:walletAddress/:category",
  validateWalletAddress,
  (req: Request, res: Response) => {
    const { walletAddress, category } = req.params;
    const cat = parseCategory(category, res);
    if (!cat) return;

    const errors = validateCategoryPreferenceUpdate(req.body);
    if (errors.length > 0) {
      sendError(
        res,
        400,
        "INVALID_PREFERENCE_UPDATE",
        errors.map((e) => `${e.field}: ${e.message}`).join(" "),
      );
      return;
    }

    const updated = updateCategoryPreference(
      walletAddress,
      cat,
      req.body as CategoryPreferenceUpdate,
    );
    res.json(updated);
  },
);

// DELETE /notifications/category-preferences/:walletAddress
router.delete(
  "/category-preferences/:walletAddress",
  validateWalletAddress,
  (req: Request, res: Response) => {
    const { walletAddress } = req.params;
    resetCategoryPreferences(walletAddress);
    res.status(204).send();
  },
);

export default router;
