/**
 * #1419 — Treasury rebalance simulation snapshots.
 *
 * `treasurySimulationService`'s `scenarioStore` persists simulation
 * *inputs* only (in-memory, lost on restart). This service persists the
 * *result* of a simulation run — a point-in-time snapshot — to the
 * database, so "what did we predict for this allocation, and when" is
 * auditable and comparable against later runs or actual outcomes.
 */
import { PrismaClient } from "@prisma/client";
import type { TreasuryScenario, SimulationResult } from "./treasurySimulationService";

const prisma = new PrismaClient();

export class SimulationSnapshotError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SimulationSnapshotError";
  }
}

export interface RebalanceSimulationSnapshotDTO {
  id: string;
  scenarioId: string | null;
  scenarioLabel: string | null;
  inputs: TreasuryScenario;
  result: SimulationResult;
  createdBy: string | null;
  createdAt: string;
}

function toDTO(row: {
  id: string;
  scenarioId: string | null;
  scenarioLabel: string | null;
  inputs: unknown;
  result: unknown;
  createdBy: string | null;
  createdAt: Date;
}): RebalanceSimulationSnapshotDTO {
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    scenarioLabel: row.scenarioLabel,
    inputs: row.inputs as TreasuryScenario,
    result: row.result as SimulationResult,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Persist a point-in-time snapshot of a completed simulation run. */
export async function saveSimulationSnapshot(
  inputs: TreasuryScenario,
  result: SimulationResult,
  options: { saved?: boolean; createdBy?: string } = {},
): Promise<RebalanceSimulationSnapshotDTO> {
  try {
    const row = await prisma.rebalanceSimulationSnapshot.create({
      data: {
        scenarioId: options.saved ? inputs.id : null,
        scenarioLabel: inputs.name ?? null,
        inputs: inputs as unknown as object,
        result: result as unknown as object,
        createdBy: options.createdBy ?? null,
      },
    });
    return toDTO(row);
  } catch {
    throw new SimulationSnapshotError(
      503,
      "SNAPSHOT_PERSIST_FAILED",
      "Failed to persist the simulation snapshot. The simulation result itself is still valid and was returned.",
    );
  }
}

export interface ListSnapshotsOptions {
  scenarioId?: string;
  limit?: number;
  cursor?: string;
}

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;

/** List snapshots newest-first, optionally scoped to one scenario. */
export async function listSimulationSnapshots(
  options: ListSnapshotsOptions = {},
): Promise<{ snapshots: RebalanceSimulationSnapshotDTO[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  try {
    const rows = await prisma.rebalanceSimulationSnapshot.findMany({
      where: options.scenarioId ? { scenarioId: options.scenarioId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      snapshots: page.map(toDTO),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  } catch {
    throw new SimulationSnapshotError(
      503,
      "SNAPSHOT_LIST_FAILED",
      "Failed to load simulation snapshots.",
    );
  }
}

/** Fetch a single snapshot by id. Throws a typed 404 if it doesn't exist. */
export async function getSimulationSnapshot(id: string): Promise<RebalanceSimulationSnapshotDTO> {
  let row;
  try {
    row = await prisma.rebalanceSimulationSnapshot.findUnique({ where: { id } });
  } catch {
    throw new SimulationSnapshotError(
      503,
      "SNAPSHOT_LOOKUP_FAILED",
      "Failed to load the requested simulation snapshot.",
    );
  }

  if (!row) {
    throw new SimulationSnapshotError(404, "SNAPSHOT_NOT_FOUND", `No simulation snapshot found with id "${id}"`);
  }

  return toDTO(row);
}
