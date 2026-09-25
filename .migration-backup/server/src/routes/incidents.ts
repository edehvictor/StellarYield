import { Router, Request, Response } from "express";
import { incidentService, IncidentFilter } from "../services/incidentService";
import { parsePaginationLimit } from "../types/pagination";

const router = Router();

/**
 * GET /api/incidents
 *
 * Returns a paginated list of incidents ordered by `startedAt` descending.
 *
 * Query parameters:
 *   protocol  — filter by protocol name (optional)
 *   severity  — filter by severity (optional)
 *   type      — filter by incident type (optional)
 *   resolved  — "true" | "false" (optional)
 *   cursor    — opaque cursor from a previous response's `pagination.nextCursor` (optional)
 *   limit     — items per page, 1–100 (default 20)
 *
 * Response:
 *   {
 *     "data": [...incidents],
 *     "pagination": { "nextCursor": string|null, "hasMore": boolean, "limit": number }
 *   }
 */
router.get("/", async (req: Request, res: Response) => {
    try {
        const filter: IncidentFilter = {
            protocol: req.query.protocol as string | undefined,
            severity: req.query.severity as string | undefined,
            type: req.query.type as string | undefined,
            resolved: req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined,
        };
        const page = await incidentService.getIncidentsPaginated(filter, {
            cursor: req.query.cursor as string | undefined,
            limit: parsePaginationLimit(req.query.limit),
        });
        res.json(page);
    } catch {
        res.status(500).json({ error: "Failed to fetch incidents" });
    }
});

router.get("/:id", async (req: Request, res: Response) => {
    try {
        const incident = await incidentService.getIncidentById(req.params.id);
        if (!incident) {
            res.status(404).json({ error: "Incident not found" });
            return;
        }
        res.json(incident);
    } catch {
        res.status(500).json({ error: "Failed to fetch incident" });
    }
});

router.post("/", async (req: Request, res: Response) => {
    try {
        const { protocol, severity, type, title, description, affectedVaults, startedAt } = req.body;
        if (!protocol || !severity || !type || !title || !description || !startedAt) {
            res.status(400).json({ error: "Missing required fields" });
            return;
        }
        const incident = await incidentService.createIncident({
            protocol,
            severity,
            type,
            title,
            description,
            affectedVaults: affectedVaults || [],
            startedAt: new Date(startedAt),
        });
        res.status(201).json(incident);
    } catch {
        res.status(500).json({ error: "Failed to create incident" });
    }
});

router.patch("/:id/resolve", async (req: Request, res: Response) => {
    try {
        const incident = await incidentService.resolveIncident(req.params.id);
        res.json(incident);
    } catch {
        res.status(500).json({ error: "Failed to resolve incident" });
    }
});

router.get("/:id/recommendations", async (req: Request, res: Response) => {
    try {
        const recommendations = await incidentService.getRecommendationsForIncident(req.params.id);
        res.json(recommendations);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch recommendations" });
    }
});

export default router;
