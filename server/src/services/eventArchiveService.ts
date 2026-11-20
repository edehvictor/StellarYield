/**
 * Issue #285: On-Chain Event Compression and Archive Service
 *
 * Provides archival pipeline for historical event records with:
 * - Compression and partitioning of old events
 * - Preserved query access for audit/analytics
 * - Data integrity during rollover
 */

export interface EventArchiveRecord {
  id: string;
  contractId: string;
  topic: string;
  data: string;
  txHash: string;
  ledger: number;
  createdAt: Date;
}

export interface ArchiveMetadata {
  archiveId: string;
  startDate: Date;
  endDate: Date;
  eventCount: number;
  compressedSize: number; // bytes
  originalSize: number; // bytes
  compressionRatio: number;
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Date;
  completedAt?: Date;
  checksumHash: string; // SHA-256 for integrity
  error?: string;
}

export interface ArchiveQueryResult {
  records: EventArchiveRecord[];
  totalCount: number;
  archiveIds: string[];
  queryTimeMs: number;
}

// ── Normalized event lookup (#1078) ─────────────────────────────────────────
//
// Audit replay and incident review tools need a consistent way to find an
// archived event again — by which source emitted it, what kind of event it
// was, and roughly when. This is a *lookup*, not a re-query of a date
// range: it's indexed by (source, eventType, timeBucket) so a replay tool
// can ask "what happened for contract X, event type Y, in bucket Z" and get
// a deterministic, deduplicated answer — even if the same event id was
// accidentally archived twice, or the requested bucket doesn't exist.

export type PartitionStrategy = ArchiveServiceConfig["partitionStrategy"];

/**
 * Compute the time-bucket key for a date under a given partition strategy.
 * Exposed as a pure function so callers (and tests) can compute the exact
 * bucket key to look up without guessing the internal format.
 */
export function computeTimeBucket(date: Date, strategy: PartitionStrategy): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const week = Math.floor(date.getDate() / 7) + 1;

  switch (strategy) {
    case "daily":
      return `${year}-${month}-${day}`;
    case "weekly":
      return `${year}-W${String(week).padStart(2, "0")}`;
    case "monthly":
    default:
      return `${year}-${month}`;
  }
}

export interface NormalizedLookupFilters {
  /** Event source — matches EventArchiveRecord.contractId. Omit to search across all sources. */
  source?: string;
  /** Event type — matches EventArchiveRecord.topic. Omit to search across all event types. */
  eventType?: string;
  /** Time bucket key, as produced by computeTimeBucket(). Omit to search all time buckets. */
  timeBucket?: string;
  /** Exact event id. When set, narrows to that single event across all matched archives. */
  id?: string;
}

export interface NormalizedLookupResult {
  records: EventArchiveRecord[];
  totalCount: number;
  /** Event ids that appeared more than once across matched archives (deduplicated in `records`). */
  duplicateIds: string[];
  /** Archive ids that contributed at least one matching record. */
  matchedArchiveIds: string[];
  queryTimeMs: number;
}

export interface ArchiveServiceConfig {
  /** Days before an event becomes eligible for archival. */
  archivalThresholdDays: number;
  /** Batch size for archival jobs. */
  batchSize: number;
  /** Maximum archive file size in bytes. */
  maxArchiveSizeBytes: number;
  /** Whether to compress archives. */
  compressionEnabled: boolean;
  /** Partition strategy: "daily", "weekly", "monthly". */
  partitionStrategy: "daily" | "weekly" | "monthly";
  /** Retention policy: how long to keep archives (days). */
  retentionDays: number;
}

export const DEFAULT_ARCHIVE_CONFIG: ArchiveServiceConfig = {
  archivalThresholdDays: 90,
  batchSize: 10000,
  maxArchiveSizeBytes: 100 * 1024 * 1024, // 100 MB
  compressionEnabled: true,
  partitionStrategy: "monthly",
  retentionDays: 7 * 365, // 7 years
};

import crypto from "crypto";
import zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Event Compression and Archive Service
 *
 * Manages archival, compression, and queryable storage of historical events.
 * Ensures data integrity and preserves audit trail.
 */
export class EventArchiveService {
  private config: ArchiveServiceConfig;
  private archives: Map<string, ArchiveMetadata> = new Map();
  /** Compressed event payload per archive — previously computed but discarded (#1078). */
  private compressedStore: Map<string, Buffer> = new Map();
  /** Normalized indexes: dimension value → set of archive ids that may contain a match. */
  private sourceIndex: Map<string, Set<string>> = new Map();
  private eventTypeIndex: Map<string, Set<string>> = new Map();
  private timeBucketIndex: Map<string, Set<string>> = new Map();

  constructor(config: Partial<ArchiveServiceConfig> = {}) {
    this.config = { ...DEFAULT_ARCHIVE_CONFIG, ...config };
  }

  /**
   * Calculate SHA-256 checksum for data integrity verification.
   */
  private calculateChecksum(data: string | Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  /**
   * Compress event data using gzip for efficient storage.
   */
  async compressEventData(events: EventArchiveRecord[]): Promise<Buffer> {
    const jsonData = JSON.stringify(events);
    if (!this.config.compressionEnabled) {
      return Buffer.from(jsonData);
    }
    return gzip(jsonData);
  }

  /**
   * Decompress archived events for retrieval.
   */
  async decompressEventData(compressedData: Buffer): Promise<EventArchiveRecord[]> {
    try {
      const decompressed = await gunzip(compressedData);
      return JSON.parse(decompressed.toString());
    } catch {
      // Fallback for uncompressed data
      return JSON.parse(compressedData.toString());
    }
  }

  /**
   * Generate partition key based on date and strategy.
   */
  private getPartitionKey(date: Date): string {
    return computeTimeBucket(date, this.config.partitionStrategy);
  }

  /** Adds an archive id to an index bucket, creating the bucket set if needed. */
  private addToIndex(index: Map<string, Set<string>>, key: string, archiveId: string): void {
    let bucket = index.get(key);
    if (!bucket) {
      bucket = new Set();
      index.set(key, bucket);
    }
    bucket.add(archiveId);
  }

  /**
   * Archive a batch of events.
   * Returns metadata about the archive created.
   */
  async archiveEvents(
    events: EventArchiveRecord[],
    checkIntegrity: boolean = true,
  ): Promise<ArchiveMetadata> {
    if (events.length === 0) {
      throw new Error("Cannot archive empty event batch");
    }

    const archiveId = `archive_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const startDate = new Date(Math.min(...events.map((e) => e.createdAt.getTime())));
    const endDate = new Date(Math.max(...events.map((e) => e.createdAt.getTime())));

    const metadata: ArchiveMetadata = {
      archiveId,
      startDate,
      endDate,
      eventCount: events.length,
      originalSize: JSON.stringify(events).length,
      compressedSize: 0,
      compressionRatio: 0,
      status: "pending",
      createdAt: new Date(),
      checksumHash: "",
    };

    try {
      metadata.status = "processing";

      // Compress events
      const compressedData = await this.compressEventData(events);
      metadata.compressedSize = compressedData.length;
      metadata.compressionRatio = metadata.compressedSize / metadata.originalSize;

      // Calculate checksum
      metadata.checksumHash = this.calculateChecksum(compressedData);

      // Validate integrity if requested
      if (checkIntegrity) {
        const decompressed = await this.decompressEventData(compressedData);
        if (decompressed.length !== events.length) {
          throw new Error("Integrity check failed: event count mismatch after decompression");
        }
      }

      metadata.status = "completed";
      metadata.completedAt = new Date();

      // Persist the compressed payload and index it (#1078) — previously
      // this was computed above and discarded, making every archived
      // event permanently unretrievable.
      this.compressedStore.set(archiveId, compressedData);
      for (const event of events) {
        this.addToIndex(this.sourceIndex, event.contractId, archiveId);
        this.addToIndex(this.eventTypeIndex, event.topic, archiveId);
        this.addToIndex(
          this.timeBucketIndex,
          this.getPartitionKey(event.createdAt),
          archiveId,
        );
      }
    } catch (error) {
      metadata.status = "failed";
      metadata.error = error instanceof Error ? error.message : "Unknown error";
    }

    this.archives.set(archiveId, metadata);
    return metadata;
  }

  /**
   * Normalized lookup for archived events (#1078), indexed by source,
   * event type, and time bucket. Powers audit replay and incident review
   * tools that need to retrieve archived events consistently — rather
   * than re-querying a date range, they ask for exactly the dimension(s)
   * they know: a contract, an event type, a time bucket, or a specific id.
   *
   * - Any filter left unset searches across all values for that
   *   dimension (e.g. omitting `source` searches across every source —
   *   "mixed sources").
   * - A time bucket (or any other filter) that matches nothing returns an
   *   empty result rather than throwing.
   * - Results are deduplicated by event id (first occurrence wins) and
   *   sorted deterministically by (createdAt, id), so repeated lookups
   *   with the same filters always return events in the same order.
   * - Any id that appeared more than once across matched archives is
   *   reported in `duplicateIds` rather than silently multiplying the
   *   result set.
   */
  async lookupEvents(filters: NormalizedLookupFilters = {}): Promise<NormalizedLookupResult> {
    const startTime = Date.now();

    const candidateSets: Set<string>[] = [];
    if (filters.source !== undefined) {
      candidateSets.push(this.sourceIndex.get(filters.source) ?? new Set());
    }
    if (filters.eventType !== undefined) {
      candidateSets.push(this.eventTypeIndex.get(filters.eventType) ?? new Set());
    }
    if (filters.timeBucket !== undefined) {
      candidateSets.push(this.timeBucketIndex.get(filters.timeBucket) ?? new Set());
    }

    let candidateArchiveIds: string[];
    if (candidateSets.length === 0) {
      // No indexed filter provided — every completed archive is a candidate.
      candidateArchiveIds = Array.from(this.archives.keys()).filter(
        (id) => this.archives.get(id)?.status === "completed",
      );
    } else {
      // Intersect all provided dimensions — a matching archive must be a
      // member of every set (missing bucket => empty set => empty result).
      const [first, ...rest] = candidateSets;
      candidateArchiveIds = Array.from(first).filter((id) => rest.every((set) => set.has(id)));
    }

    const seen = new Map<string, EventArchiveRecord>();
    const duplicateIds = new Set<string>();
    const matchedArchiveIds = new Set<string>();

    for (const archiveId of candidateArchiveIds) {
      const metadata = this.archives.get(archiveId);
      const compressed = this.compressedStore.get(archiveId);
      if (!metadata || metadata.status !== "completed" || !compressed) continue;

      const records = await this.decompressEventData(compressed);
      for (const record of records) {
        if (filters.source !== undefined && record.contractId !== filters.source) continue;
        if (filters.eventType !== undefined && record.topic !== filters.eventType) continue;
        if (
          filters.timeBucket !== undefined &&
          this.getPartitionKey(new Date(record.createdAt)) !== filters.timeBucket
        ) {
          continue;
        }
        if (filters.id !== undefined && record.id !== filters.id) continue;

        matchedArchiveIds.add(archiveId);

        if (seen.has(record.id)) {
          duplicateIds.add(record.id);
        } else {
          seen.set(record.id, record);
        }
      }
    }

    const dedupedRecords = Array.from(seen.values()).sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      if (aTime !== bTime) return aTime - bTime;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return {
      records: dedupedRecords,
      totalCount: dedupedRecords.length,
      duplicateIds: Array.from(duplicateIds),
      matchedArchiveIds: Array.from(matchedArchiveIds),
      queryTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Query events across multiple archives.
   * Returns results from specified date range and topics.
   */
  async queryArchives(
    startDate: Date,
    endDate: Date,
    filters?: {
      contractId?: string;
      topic?: string;
    },
  ): Promise<ArchiveQueryResult> {
    const startTime = Date.now();
    const results: EventArchiveRecord[] = [];
    const archiveIds: string[] = [];

    for (const [archiveId, metadata] of this.archives) {
      // Skip if archive is outside date range
      if (
        metadata.endDate < startDate ||
        metadata.startDate > endDate ||
        metadata.status !== "completed"
      ) {
        continue;
      }

      archiveIds.push(archiveId);

      // In production, would fetch from storage
      // For now, tracking as retrieved
    }

    const queryTimeMs = Date.now() - startTime;

    return {
      records: results,
      totalCount: results.length,
      archiveIds,
      queryTimeMs,
    };
  }

  /**
   * Get archive metadata by ID.
   */
  getArchiveMetadata(archiveId: string): ArchiveMetadata | undefined {
    return this.archives.get(archiveId);
  }

  /**
   * List all archives with optional filtering.
   */
  listArchives(
    filters?: {
      status?: "pending" | "processing" | "completed" | "failed";
      startDate?: Date;
      endDate?: Date;
    },
  ): ArchiveMetadata[] {
    let archives = Array.from(this.archives.values());

    if (filters?.status) {
      archives = archives.filter((a) => a.status === filters.status);
    }

    if (filters?.startDate) {
      archives = archives.filter((a) => a.endDate >= filters.startDate!);
    }

    if (filters?.endDate) {
      archives = archives.filter((a) => a.startDate <= filters.endDate!);
    }

    return archives.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Verify archive integrity by checksum.
   */
  async verifyArchiveIntegrity(archiveId: string, data: Buffer): Promise<boolean> {
    const metadata = this.archives.get(archiveId);
    if (!metadata) {
      throw new Error(`Archive not found: ${archiveId}`);
    }

    const calculatedHash = this.calculateChecksum(data);
    return calculatedHash === metadata.checksumHash;
  }

  /**
   * Delete archive (after retention period).
   */
  deleteArchive(archiveId: string): boolean {
    this.compressedStore.delete(archiveId);
    return this.archives.delete(archiveId);
  }

  /**
   * Get archival statistics.
   */
  getArchiveStats(): {
    totalArchives: number;
    completedArchives: number;
    totalEventsArchived: number;
    totalStorageBytes: number;
    averageCompressionRatio: number;
  } {
    const archives = Array.from(this.archives.values());
    const completed = archives.filter((a) => a.status === "completed");

    const totalEventsArchived = completed.reduce((sum, a) => sum + a.eventCount, 0);
    const totalStorageBytes = completed.reduce((sum, a) => sum + a.compressedSize, 0);
    const averageCompressionRatio =
      completed.length > 0
        ? completed.reduce((sum, a) => sum + a.compressionRatio, 0) / completed.length
        : 0;

    return {
      totalArchives: archives.length,
      completedArchives: completed.length,
      totalEventsArchived,
      totalStorageBytes,
      averageCompressionRatio,
    };
  }
}

// Export singleton instance
export const eventArchiveService = new EventArchiveService();
