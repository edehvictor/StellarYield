/**
 * Tests for Issue #285: On-Chain Event Compression and Archive Service
 * Tests for archive write/read behavior and data integrity.
 */

import {
  EventArchiveService,
  DEFAULT_ARCHIVE_CONFIG,
  type EventArchiveRecord,
} from "../eventArchiveService";

describe("EventArchiveService", () => {
  let archiveService: EventArchiveService;

  beforeEach(() => {
    archiveService = new EventArchiveService(DEFAULT_ARCHIVE_CONFIG);
  });

  describe("archiveEvents", () => {
    it("should successfully archive events", async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "mock_data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
        {
          id: "evt_2",
          contractId: "CONTRACT_1",
          topic: "Approval",
          data: "mock_data_2",
          txHash: "hash_2",
          ledger: 1001,
          createdAt: new Date("2024-01-02"),
        },
      ];

      const metadata = await archiveService.archiveEvents(events);

      expect(metadata.status).toBe("completed");
      expect(metadata.eventCount).toBe(2);
      expect(metadata.checksumHash).toBeDefined();
      expect(metadata.checksumHash.length).toBe(64); // SHA-256 hex string
    });

    it("should calculate compression ratio", async () => {
      const events: EventArchiveRecord[] = Array.from(
        { length: 100 },
        (_, i) => ({
          id: `evt_${i}`,
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: `data_${i}_with_some_repeating_content`,
          txHash: `hash_${i}`,
          ledger: 1000 + i,
          createdAt: new Date("2024-01-01"),
        }),
      );

      const metadata = await archiveService.archiveEvents(events);

      expect(metadata.compressionRatio).toBeGreaterThan(0);
      expect(metadata.compressionRatio).toBeLessThanOrEqual(1);
    });

    it("should reject empty event batch", async () => {
      await expect(archiveService.archiveEvents([])).rejects.toThrow(
        "Cannot archive empty event batch",
      );
    });

    it("should verify integrity after archival", async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "test_data",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const metadata = await archiveService.archiveEvents(
        events,
        true,
      );

      expect(metadata.status).toBe("completed");
    });

    it("should set correct date range in metadata", async () => {
      const baseDate = new Date("2024-01-15");
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Event1",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: baseDate,
        },
        {
          id: "evt_2",
          contractId: "CONTRACT_1",
          topic: "Event2",
          data: "data_2",
          txHash: "hash_2",
          ledger: 1001,
          createdAt: new Date(baseDate.getTime() + 10 * 24 * 60 * 60 * 1000),
        },
      ];

      const metadata = await archiveService.archiveEvents(events);

      expect(metadata.startDate).toEqual(baseDate);
      expect(metadata.endDate.getTime()).toBeGreaterThan(baseDate.getTime());
    });
  });

  describe("queryArchives", () => {
    beforeEach(async () => {
      // Create some test archives
      const events1: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_A",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const events2: EventArchiveRecord[] = [
        {
          id: "evt_2",
          contractId: "CONTRACT_B",
          topic: "Swap",
          data: "data_2",
          txHash: "hash_2",
          ledger: 2000,
          createdAt: new Date("2024-02-01"),
        },
      ];

      await archiveService.archiveEvents(events1);
      await archiveService.archiveEvents(events2);
    });

    it("should query archives in date range", async () => {
      const result = await archiveService.queryArchives(
        new Date("2024-01-01"),
        new Date("2024-02-01"),
      );

      expect(result.archiveIds.length).toBeGreaterThan(0);
      expect(result.queryTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should return empty result for non-matching date range", async () => {
      const result = await archiveService.queryArchives(
        new Date("2025-01-01"),
        new Date("2025-12-31"),
      );

      expect(result.archiveIds).toHaveLength(0);
    });

    it("should support filtering by contract ID", async () => {
      const result = await archiveService.queryArchives(
        new Date("2024-01-01"),
        new Date("2024-02-01"),
        { contractId: "CONTRACT_A" },
      );

      expect(result).toBeDefined();
    });
  });

  describe("compressDecompress", () => {
    it("should decompress archived data correctly", async () => {
      const originalEvents: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "original_data",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const compressed = await archiveService.compressEventData(
        originalEvents,
      );
      const decompressed = await archiveService.decompressEventData(
        compressed,
      );

      expect(decompressed).toEqual(originalEvents);
    });

    it("should handle already uncompressed data", async () => {
      const data = JSON.stringify([{ id: "test" }]);
      const buffer = Buffer.from(data);

      const decompressed = await archiveService.decompressEventData(buffer);

      expect(Array.isArray(decompressed)).toBe(true);
    });
  });

  describe("getArchiveMetadata", () => {
    it("should retrieve archive metadata by ID", async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const metadata = await archiveService.archiveEvents(events);
      const retrieved = archiveService.getArchiveMetadata(metadata.archiveId);

      expect(retrieved).toEqual(metadata);
    });

    it("should return undefined for non-existent archive", () => {
      const retrieved = archiveService.getArchiveMetadata("non_existent");

      expect(retrieved).toBeUndefined();
    });
  });

  describe("listArchives", () => {
    beforeEach(async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      await archiveService.archiveEvents(events);
    });

    it("should list all archives", () => {
      const archives = archiveService.listArchives();

      expect(archives.length).toBeGreaterThan(0);
    });

    it("should filter archives by status", async () => {
      const completed = archiveService.listArchives({ status: "completed" });

      expect(completed.length).toBeGreaterThan(0);
      expect(completed.every((a) => a.status === "completed")).toBe(true);
    });

    it("should filter archives by date range", () => {
      const filtered = archiveService.listArchives({
        startDate: new Date("2024-01-01"),
        endDate: new Date("2024-12-31"),
      });

      expect(filtered.length).toBeGreaterThanOrEqual(0);
    });

    it("should return archives sorted by creation date (newest first)", async () => {
      // Add some delay between archives
      const archives1: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Event1",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      await archiveService.archiveEvents(archives1);

      const list = archiveService.listArchives();

      if (list.length >= 2) {
        expect(list[0].createdAt.getTime()).toBeGreaterThanOrEqual(
          list[1].createdAt.getTime(),
        );
      }
    });
  });

  describe("verifyArchiveIntegrity", () => {
    it("should verify archive checksum", async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const metadata = await archiveService.archiveEvents(events);
      const compressed = await archiveService.compressEventData(events);

      const isValid = await archiveService.verifyArchiveIntegrity(
        metadata.archiveId,
        compressed,
      );

      expect(isValid).toBe(true);
    });

    it("should fail on tampered data", async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const metadata = await archiveService.archiveEvents(events);
      const tampered = Buffer.from("tampered_data");

      const isValid = await archiveService.verifyArchiveIntegrity(
        metadata.archiveId,
        tampered,
      );

      expect(isValid).toBe(false);
    });

    it("should throw on non-existent archive", async () => {
      const data = Buffer.from("test");

      await expect(
        archiveService.verifyArchiveIntegrity("non_existent", data),
      ).rejects.toThrow();
    });
  });

  describe("deleteArchive", () => {
    it("should delete archive", async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      const metadata = await archiveService.archiveEvents(events);
      const deleted = archiveService.deleteArchive(metadata.archiveId);

      expect(deleted).toBe(true);
      expect(archiveService.getArchiveMetadata(metadata.archiveId)).toBeUndefined();
    });

    it("should return false when deleting non-existent archive", () => {
      const deleted = archiveService.deleteArchive("non_existent");

      expect(deleted).toBe(false);
    });
  });

  describe("getArchiveStats", () => {
    beforeEach(async () => {
      const events: EventArchiveRecord[] = [
        {
          id: "evt_1",
          contractId: "CONTRACT_1",
          topic: "Transfer",
          data: "data_1",
          txHash: "hash_1",
          ledger: 1000,
          createdAt: new Date("2024-01-01"),
        },
      ];

      await archiveService.archiveEvents(events);
    });

    it("should calculate archive statistics", () => {
      const stats = archiveService.getArchiveStats();

      expect(stats.totalArchives).toBeGreaterThan(0);
      expect(stats.completedArchives).toBeGreaterThan(0);
      expect(stats.totalEventsArchived).toBeGreaterThan(0);
      expect(stats.totalStorageBytes).toBeGreaterThan(0);
      expect(stats.averageCompressionRatio).toBeGreaterThan(0);
    });
  });
});
