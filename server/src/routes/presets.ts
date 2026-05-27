import { Router, Request, Response } from "express";
import {
  validatePreset,
  createPreset,
  getPresetsForWallet,
  getPreset,
  updatePreset,
  deletePreset,
  type PresetAllocation,
} from "../services/allocationPresetsService";

const router = Router();

function walletParam(req: Request): string {
  return (req.query.wallet as string) ?? "";
}

/**
 * GET /api/presets?wallet=<address>
 * List all presets for a wallet.
 */
router.get("/", (req: Request, res: Response) => {
  const wallet = walletParam(req);
  if (!wallet) {
    res.status(400).json({ error: "wallet query parameter is required" });
    return;
  }
  res.json(getPresetsForWallet(wallet));
});

/**
 * POST /api/presets
 * Create a new preset.
 */
router.post("/", (req: Request, res: Response) => {
  const { walletAddress, name, allocations } = req.body as {
    walletAddress?: string;
    name?: string;
    allocations?: PresetAllocation[];
  };

  const validation = validatePreset(
    walletAddress ?? "",
    name ?? "",
    allocations ?? [],
  );
  if (!validation.ok) {
    res.status(400).json({ errors: validation.errors });
    return;
  }

  const preset = createPreset(walletAddress!, name!, allocations!);
  res.status(201).json(preset);
});

/**
 * GET /api/presets/:id?wallet=<address>
 * Get a single preset.
 */
router.get("/:id", (req: Request, res: Response) => {
  const wallet = walletParam(req);
  if (!wallet) {
    res.status(400).json({ error: "wallet query parameter is required" });
    return;
  }
  const preset = getPreset(wallet, req.params.id);
  if (!preset) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }
  res.json(preset);
});

/**
 * PUT /api/presets/:id
 * Update an existing preset.
 */
router.put("/:id", (req: Request, res: Response) => {
  const { walletAddress, name, allocations } = req.body as {
    walletAddress?: string;
    name?: string;
    allocations?: PresetAllocation[];
  };

  const validation = validatePreset(
    walletAddress ?? "",
    name ?? "",
    allocations ?? [],
  );
  if (!validation.ok) {
    res.status(400).json({ errors: validation.errors });
    return;
  }

  const updated = updatePreset(walletAddress!, req.params.id, name!, allocations!);
  if (!updated) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }
  res.json(updated);
});

/**
 * DELETE /api/presets/:id?wallet=<address>
 * Delete a preset.
 */
router.delete("/:id", (req: Request, res: Response) => {
  const wallet = walletParam(req);
  if (!wallet) {
    res.status(400).json({ error: "wallet query parameter is required" });
    return;
  }
  const deleted = deletePreset(wallet, req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Preset not found" });
    return;
  }
  res.status(204).send();
});

export default router;
