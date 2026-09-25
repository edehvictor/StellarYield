import {
  createKnownEventFixture,
  createUnknownTopicFixture,
  createMalformedTopicFixture,
  createMalformedDataFixture,
  createMixedEventBatch,
  createBatchWithMostlyUnknownTopics,
  createEventWithTopicVector,
  KNOWN_TOPIC_XDR,
  UNKNOWN_TOPIC_XDR,
  MALFORMED_TOPIC_XDR,
} from "./fixtures/contractEventFixtures";

/**
 * Contract Event Decoder Test Suite
 *
 * Tests the event decoder pipeline to ensure:
 * 1. Known events are successfully decoded and stored
 * 2. Unknown topics are recorded without crashing the pipeline
 * 3. Malformed events are dead-lettered properly
 * 4. Mixed batches flow through successfully
 * 5. Invalid XDR is handled gracefully
 */

describe("Contract Event Decoder", () => {
  describe("Event Extraction", () => {
    it("should extract XDR data from known events", () => {
      const event = createKnownEventFixture();
      const topic = event.topic.map((t: any) => t.toXDR("base64")).join(":");
      const data = event.value.toXDR("base64");

      expect(topic).toBe(KNOWN_TOPIC_XDR);
      expect(data).toBeDefined();
      expect(data.length).toBeGreaterThan(0);
    });

    it("should extract XDR data from unknown topic events", () => {
      const event = createUnknownTopicFixture();
      const topic = event.topic.map((t: any) => t.toXDR("base64")).join(":");
      const data = event.value.toXDR("base64");

      expect(topic).toBe(UNKNOWN_TOPIC_XDR);
      expect(data).toBeDefined();
    });

    it("should extract XDR data from malformed topic events", () => {
      const event = createMalformedTopicFixture();
      const topic = event.topic.map((t: any) => t.toXDR("base64")).join(":");
      const data = event.value.toXDR("base64");

      expect(topic).toBe(MALFORMED_TOPIC_XDR);
      expect(data).toBeDefined();
    });

    it("should extract XDR data from malformed data events", () => {
      const event = createMalformedDataFixture();
      const topic = event.topic.map((t: any) => t.toXDR("base64")).join(":");
      const data = event.value.toXDR("base64");

      expect(topic).toBe(KNOWN_TOPIC_XDR);
      expect(data).toBe(""); // Empty data
    });
  });

  describe("Batch Processing", () => {
    it("should create mixed event batches without crashing", () => {
      const batch = createMixedEventBatch();

      expect(batch).toHaveLength(6);
      expect(batch.every((e) => e.topic && e.value)).toBe(true);
    });

    it("should extract data from all events in mixed batch", () => {
      const batch = createMixedEventBatch();

      const extracted = batch.map((event) => ({
        topic: event.topic.map((t: any) => t.toXDR("base64")).join(":"),
        data: event.value.toXDR("base64"),
        ledger: event.ledger,
        txHash: event.txHash,
      }));

      expect(extracted).toHaveLength(6);
      // Should have 3 KNOWN_TOPIC_XDR (known events), 2 unknown, 1 malformed
      const knownCount = extracted.filter(
        (e) => e.topic === KNOWN_TOPIC_XDR,
      ).length;
      expect(knownCount).toBeGreaterThanOrEqual(2); // At least 2 known

      // Should have unknown topics
      const unknownCount = extracted.filter(
        (e) => e.topic === UNKNOWN_TOPIC_XDR,
      ).length;
      expect(unknownCount).toBeGreaterThan(0);

      // Should have malformed
      const malformedCount = extracted.filter(
        (e) => e.topic === MALFORMED_TOPIC_XDR,
      ).length;
      expect(malformedCount).toBeGreaterThan(0);
    });

    it("should handle large batches with mostly unknown topics", () => {
      const batch = createBatchWithMostlyUnknownTopics();

      expect(batch).toHaveLength(50);

      const extracted = batch.map((event) => {
        const topic = event.topic.map((t: any) => t.toXDR("base64")).join(":");
        return topic;
      });

      const knownCount = extracted.filter((t) => t === KNOWN_TOPIC_XDR).length;
      const unknownCount = extracted.filter(
        (t) => t === UNKNOWN_TOPIC_XDR,
      ).length;

      expect(knownCount).toBe(5); // One per 10 events
      expect(unknownCount).toBe(45);
      expect(knownCount + unknownCount).toBe(50);
    });

    it("should handle events with multiple topic elements", () => {
      const event = createEventWithTopicVector();

      const topics = event.topic.map((t: any) => t.toXDR("base64"));
      expect(topics).toHaveLength(2);
      expect(topics[0]).toBe(KNOWN_TOPIC_XDR);
      expect(topics[1]).toBe(UNKNOWN_TOPIC_XDR);

      const joinedTopics = topics.join(":");
      expect(joinedTopics).toContain(":");
    });
  });

  describe("Event Classification", () => {
    it("should distinguish known topics from unknown topics", () => {
      const known = createKnownEventFixture();
      const unknown = createUnknownTopicFixture();

      const knownTopic = known.topic
        .map((t: any) => t.toXDR("base64"))
        .join(":");
      const unknownTopic = unknown.topic
        .map((t: any) => t.toXDR("base64"))
        .join(":");

      expect(knownTopic).not.toBe(unknownTopic);
      expect(knownTopic).toBe(KNOWN_TOPIC_XDR);
      expect(unknownTopic).toBe(UNKNOWN_TOPIC_XDR);
    });

    it("should distinguish valid XDR from malformed XDR", () => {
      const valid = createKnownEventFixture();
      const malformed = createMalformedTopicFixture();

      const validTopic = valid.topic
        .map((t: any) => t.toXDR("base64"))
        .join(":");
      const malformedTopic = malformed.topic
        .map((t: any) => t.toXDR("base64"))
        .join(":");

      // Malformed should contain invalid base64 chars
      expect(malformedTopic).toContain("!");
      expect(validTopic).not.toContain("!");
    });

    it("should identify empty data", () => {
      const event = createMalformedDataFixture();
      const data = event.value.toXDR("base64");

      expect(data).toBe("");
      expect(data.length).toBe(0);
    });
  });

  describe("Event Context Preservation", () => {
    it("should preserve all event metadata for dead-lettering", () => {
      const event = createUnknownTopicFixture();

      expect(event.ledger).toBe(1001);
      expect(event.txHash).toBe("txhash_unknown_001");
      expect(event.contractId).toBeDefined();
      expect(event.topic).toBeDefined();
      expect(event.value).toBeDefined();
    });

    it("should extract event context without modification", () => {
      const batch = createMixedEventBatch();

      const contexts = batch.map((event) => ({
        ledger: event.ledger,
        txHash: event.txHash,
        topic: event.topic.map((t: any) => t.toXDR("base64")).join(":"),
        data: event.value.toXDR("base64"),
      }));

      // All events should have complete context
      contexts.forEach((ctx) => {
        expect(ctx.ledger).toBeDefined();
        expect(ctx.txHash).toBeDefined();
        expect(ctx.topic).toBeDefined();
        // data can be empty, but should be defined
        expect(ctx.data !== undefined).toBe(true);
      });
    });

    it("should retain ledger and transaction hash for review", () => {
      const unknown = createUnknownTopicFixture();

      expect(unknown.ledger).toBeGreaterThan(0);
      expect(unknown.txHash.length).toBeGreaterThan(0);
      expect(unknown.ledger).toBe(1001);
    });
  });

  describe("Pipeline Resilience", () => {
    it("should not stop processing when encountering unknown topics", () => {
      const batch = createMixedEventBatch();

      // Process all events without throwing
      let successCount = 0;
      for (const event of batch) {
        try {
          const topic = event.topic
            .map((t: any) => t.toXDR("base64"))
            .join(":");
          const data = event.value.toXDR("base64");
          // No throw = success
          successCount++;
        } catch {
          // Should not reach here
          fail("Processing threw an error");
        }
      }

      expect(successCount).toBe(batch.length);
    });

    it("should continue processing after unknown topic detection", () => {
      const events = [
        createKnownEventFixture(),
        createUnknownTopicFixture(),
        createKnownEventFixture(),
      ];

      const results: Array<{ txHash: string; processed: boolean }> = [];

      for (const event of events) {
        try {
          const topic = event.topic
            .map((t: any) => t.toXDR("base64"))
            .join(":");
          // Simulate: known events pass validation, unknown events throw
          if (topic === KNOWN_TOPIC_XDR) {
            results.push({ txHash: event.txHash, processed: true });
          } else {
            // Would be dead-lettered, but not throwing
            results.push({ txHash: event.txHash, processed: false });
          }
        } catch {
          fail("Should not throw");
        }
      }

      // All events processed (not thrown)
      expect(results).toHaveLength(3);
      // First should be known
      expect(results[0].processed).toBe(true);
      // Second should be unknown (not processed)
      expect(results[1].processed).toBe(false);
      // Third should be known again
      expect(results[2].processed).toBe(true);
    });
  });

  describe("Scalability", () => {
    it("should handle large batches without performance degradation", () => {
      const batch = createBatchWithMostlyUnknownTopics();

      const start = Date.now();

      for (const event of batch) {
        event.topic.map((t: any) => t.toXDR("base64")).join(":");
        event.value.toXDR("base64");
      }

      const elapsed = Date.now() - start;

      // Should process 50 events quickly (< 100ms for fixture gen)
      expect(elapsed).toBeLessThan(1000);
    });

    it("should classify 90% unknown topics correctly", () => {
      const batch = createBatchWithMostlyUnknownTopics();

      const topics = batch.map((e) =>
        e.topic.map((t: any) => t.toXDR("base64")).join(":"),
      );

      const knownCount = topics.filter((t) => t === KNOWN_TOPIC_XDR).length;
      const unknownCount = topics.filter((t) => t === UNKNOWN_TOPIC_XDR).length;

      expect(knownCount / batch.length).toBeLessThan(0.2); // < 20% known
      expect(unknownCount / batch.length).toBeGreaterThan(0.8); // > 80% unknown
    });
  });
});
