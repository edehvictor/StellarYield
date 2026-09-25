/**
 * contactNormalization.test.ts — Issue #1182
 *
 * Tests for contact import duplicate detection across nickname changes:
 * 1. Address normalization handles case variations
 * 2. Address normalization trims whitespace
 * 3. Duplicate detection identifies same address with different names
 * 4. Duplicate detection identifies same address with same name
 * 5. New contacts are correctly identified
 * 6. Review summary counts are accurate
 */

import {
  normalizeAddress,
  reviewImportContacts,
  type ImportContactReview,
} from "../services/contactNormalization";

describe("contactNormalization (#1182)", () => {
  describe("normalizeAddress", () => {
    it("trims whitespace", () => {
      expect(normalizeAddress("  GALCDR5SNTLQ  ")).toBe("GALCDR5SNTLQ");
    });

    it("lowercases to uppercase", () => {
      expect(normalizeAddress("galcdr5sntlq")).toBe("GALCDR5SNTLQ");
    });

    it("removes non-alphanumeric characters", () => {
      expect(normalizeAddress("GALC-DR5S-NTLQ")).toBe("GALCDR5SNTLQ");
    });

    it("handles mixed case with special characters", () => {
      expect(normalizeAddress("  galc-dr5s-ntlq  ")).toBe("GALCDR5SNTLQ");
    });

    it("returns empty string for empty input", () => {
      expect(normalizeAddress("")).toBe("");
    });

    it("returns empty string for whitespace-only input", () => {
      expect(normalizeAddress("   ")).toBe("");
    });

    it("preserves G prefix", () => {
      expect(normalizeAddress("GABC123")).toBe("GABC123");
    });

    it("normalizes case-insensitive addresses to same value", () => {
      const addr1 = normalizeAddress("GALCDR5SNTLQ7W6HNSG6VYJSNM3GVVMAJKXWCRLV4W65T2CQZQCFXYZ");
      const addr2 = normalizeAddress("galcdr5sntlq7w6hnsg6vyjsnm3gvvmajkxwcrlv4w65t2cqzqcfxyz");
      expect(addr1).toBe(addr2);
    });
  });

  describe("reviewImportContacts", () => {
    const existingContacts = [
      { id: "existing-1", encryptedName: "enc_name_alice", encryptedAddress: "enc_addr_alice" },
      { id: "existing-2", encryptedName: "enc_name_bob", encryptedAddress: "enc_addr_bob" },
    ];

    it("identifies new contacts (no match)", () => {
      const importContacts = [
        { encryptedName: "enc_name_charlie", encryptedAddress: "enc_addr_charlie" },
      ];

      const reviews = reviewImportContacts(importContacts, existingContacts);

      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("new");
      expect(reviews[0].existingContactId).toBeUndefined();
    });

    it("identifies duplicates (same address, same name)", () => {
      const importContacts = [
        { encryptedName: "enc_name_alice", encryptedAddress: "enc_addr_alice" },
      ];

      const reviews = reviewImportContacts(importContacts, existingContacts);

      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("duplicate");
      expect(reviews[0].existingContactId).toBe("existing-1");
    });

    it("identifies updates (same address, different name)", () => {
      const importContacts = [
        { encryptedName: "enc_name_alice_v2", encryptedAddress: "enc_addr_alice" },
      ];

      const reviews = reviewImportContacts(importContacts, existingContacts);

      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("updated");
      expect(reviews[0].existingContactId).toBe("existing-1");
    });

    it("handles nickname-only changes via address normalization", () => {
      // When encrypted addresses normalize to the same value but names differ
      // This simulates the case where a contact's nickname was changed
      const importContacts = [
        { encryptedName: "enc_name_alice_renamed", encryptedAddress: "enc_addr_alice_normalized" },
      ];

      const existingWithNormalized = [
        { id: "existing-1", encryptedName: "enc_name_alice", encryptedAddress: "enc_addr_alice_normalized" },
      ];

      const reviews = reviewImportContacts(importContacts, existingWithNormalized);

      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("updated");
    });

    it("handles mixed new and duplicate contacts", () => {
      const importContacts = [
        { encryptedName: "enc_name_alice", encryptedAddress: "enc_addr_alice" },
        { encryptedName: "enc_name_charlie", encryptedAddress: "enc_addr_charlie" },
      ];

      const reviews = reviewImportContacts(importContacts, existingContacts);

      expect(reviews).toHaveLength(2);
      expect(reviews[0].state).toBe("duplicate");
      expect(reviews[1].state).toBe("new");
    });

    it("returns normalized address in review", () => {
      const importContacts = [
        { encryptedName: "enc_name_charlie", encryptedAddress: "enc_addr_charlie" },
      ];

      const reviews = reviewImportContacts(importContacts, existingContacts);

      expect(reviews[0].normalizedAddress).toBeDefined();
      expect(typeof reviews[0].normalizedAddress).toBe("string");
    });

    it("handles empty import list", () => {
      const reviews = reviewImportContacts([], existingContacts);
      expect(reviews).toHaveLength(0);
    });

    it("handles empty existing list", () => {
      const importContacts = [
        { encryptedName: "enc_name_charlie", encryptedAddress: "enc_addr_charlie" },
      ];

      const reviews = reviewImportContacts(importContacts, []);

      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("new");
    });
  });
});
