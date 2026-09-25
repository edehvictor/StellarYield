import { Router, Request, Response } from "express";
import {
    getFeatureFlagStatuses,
    getFeatureFlagStatus,
} from "../services/featureFlagsService";

const router = Router();

/**
 * GET /api/feature-flags
 *
 * Returns every registered feature flag with its resolved state, source
 * (environment override vs. built-in default), and a description — used
 * by the frontend feature flag diagnostics panel.
 */
router.get("/", (_req: Request, res: Response) => {
    res.json({ flags: getFeatureFlagStatuses() });
});

/**
 * GET /api/feature-flags/:key
 */
router.get("/:key", (req: Request, res: Response) => {
    const flag = getFeatureFlagStatus(req.params.key);
    if (!flag) {
        res.status(404).json({ error: `Unknown feature flag "${req.params.key}"` });
        return;
    }
    res.json(flag);
});

export default router;
