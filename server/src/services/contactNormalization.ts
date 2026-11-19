/**
 * contactNormalization.ts — Issue #1182
 *
 * Address normalization and duplicate detection for contact imports.
 * Detects duplicate contacts even when nicknames have changed but
 * wallet addresses still match.
 */

/**
 * Normalizes a Stellar address for comparison purposes.
 * Trims whitespace, lowercases, and removes any non-alphanumeric characters
 * except the leading G/T prefix.
 */
export function normalizeAddress(address: string): string {
  if (!address) return "";
  const trimmed = address.trim();
  if (trimmed.length === 0) return "";
  const upper = trimmed.toUpperCase();
  return upper.replace(/[^A-Z0-9]/g, "");
}

/**
 * Represents the review state of a contact during import.
 */
export type ImportContactState = "new" | "duplicate" | "updated";

/**
 * A contact item with its import review state.
 */
export interface ImportContactReview {
  encryptedName: string;
  encryptedAddress: string;
  normalizedAddress: string;
  state: ImportContactState;
  existingContactId?: string;
}

/**
 * Review import contacts for duplicates against existing contacts.
 *
 * Returns a list of contacts with their review state:
 * - "new": Contact does not exist (will be created)
 * - "duplicate": Contact with same normalized address and same name (will be skipped)
 * - "updated": Contact with same normalized address but different name (will be updated)
 *
 * @param importContacts - The contacts to import (with encrypted data)
 * @param existingContacts - The existing contacts (with encrypted data)
 */
export function reviewImportContacts(
  importContacts: Array<{ encryptedName: string; encryptedAddress: string }>,
  existingContacts: Array<{ id: string; encryptedName: string; encryptedAddress: string }>,
): ImportContactReview[] {
  const existingByNormalizedAddress = new Map<string, { id: string; encryptedName: string }>();
  for (const existing of existingContacts) {
    const normalized = normalizeAddress(existing.encryptedAddress);
    if (normalized && !existingByNormalizedAddress.has(normalized)) {
      existingByNormalizedAddress.set(normalized, {
        id: existing.id,
        encryptedName: existing.encryptedName,
      });
    }
  }

  return importContacts.map((contact) => {
    const normalizedAddress = normalizeAddress(contact.encryptedAddress);
    const existing = existingByNormalizedAddress.get(normalizedAddress);

    if (!existing) {
      return {
        encryptedName: contact.encryptedName,
        encryptedAddress: contact.encryptedAddress,
        normalizedAddress,
        state: "new" as ImportContactState,
      };
    }

    // Same normalized address exists - check if name changed
    const nameChanged = existing.encryptedName !== contact.encryptedName;

    return {
      encryptedName: contact.encryptedName,
      encryptedAddress: contact.encryptedAddress,
      normalizedAddress,
      state: nameChanged ? "updated" : "duplicate",
      existingContactId: existing.id,
    };
  });
}

/**
 * Summary of an import review.
 */
export interface ImportReviewSummary {
  total: number;
  newCount: number;
  duplicateCount: number;
  updatedCount: number;
  contacts: ImportContactReview[];
}
