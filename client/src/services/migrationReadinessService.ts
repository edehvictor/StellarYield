/**
 * Client-side service for the vault migration readiness checklist (#1293).
 *
 * Fetches the deterministic readiness report from
 * GET /api/vaults/migration-readiness/:slug and surfaces typed error states.
 */

import { apiUrl, apiFetch } from "../lib/api";

export type MigrationGateStatus = "pass" | "warn" | "fail" | "unknown";
export type MigrationTargetArea = "contract" | "server" | "client" | "devops";

export interface ReadinessGate {
  id: string;
  title: string;
  description: string;
  targetArea: MigrationTargetArea;
  evidenceType: string;
  reference: string;
  guidance: string;
  status: MigrationGateStatus;
  evidence: string[];
}

export interface MigrationReadinessReport {
  vaultSlug: string;
  vaultName: string;
  network: string;
  overallStatus: "ready" | "not_ready" | "unknown";
  statusCounts: Record<MigrationGateStatus, number>;
  gates: ReadinessGate[];
}

interface Envelope<T> {
  ok: true;
  data: T;
  meta: { generatedAt: string; route: string; warnings?: string[] };
}

export class MigrationReadinessService {
  private static readonly baseUrl = "/api/vaults/migration-readiness";

  static async getReadiness(slug: string): Promise<MigrationReadinessReport> {
    const response = await apiFetch(
      apiUrl(`${this.baseUrl}/${encodeURIComponent(slug)}`),
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch migration readiness: ${response.statusText}`,
      );
    }

    const envelope = (await response.json()) as Envelope<MigrationReadinessReport>;
    return envelope.data;
  }
}