import { Router, Request, Response } from "express";
import { incidentService, IncidentFilter } from "../services/incidentService";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
    try {
        const filter: IncidentFilter = {
            protocol: req.query.protocol as string,
            severity: req.query.severity as string,
            type: req.query.type as string,
            resolved: req.query.resolved === "true" ? true : req.query.resolved === "false" ? false : undefined,
        };
        const incidents = await incidentService.getIncidents(filter);
        res.json(incidents);
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

export default router;
