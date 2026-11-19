import { describe, expect, it } from "vitest";
import {
  createSignerRotationAuditRecord,
  serializeSignerRotationAuditCsv,
  SIGNER_ROTATION_AUDIT_HEADERS,
} from "./signerRotationAudit";
import type { GovernanceConfig } from "./types";

const previous: GovernanceConfig = {
  signers: ["G-ALPHA", "G-BETA"],
  threshold: 2,
  contractId: "C-GOVERNANCE",
};

describe("signer rotation audit", () => {
  it("records additions, removals, threshold changes, and the acting wallet", () => {
    const record = createSignerRotationAuditRecord(
      previous,
      {
        signers: ["G-ALPHA", "G-GAMMA"],
        threshold: 1,
        contractId: "C-GOVERNANCE",
      },
      "G-ADMIN",
      "2026-10-18T15:00:00.000Z",
    );

    expect(record).toEqual({
      timestamp: "2026-10-18T15:00:00.000Z",
      actor: "G-ADMIN",
      contractId: "C-GOVERNANCE",
      previousThreshold: 2,
      nextThreshold: 1,
      addedSigners: ["G-GAMMA"],
      removedSigners: ["G-BETA"],
    });
  });

  it("returns no event when the signer configuration is unchanged", () => {
    expect(
      createSignerRotationAuditRecord(
        previous,
        { ...previous, signers: ["G-BETA", "G-ALPHA"] },
        "G-ADMIN",
        "2026-10-18T15:00:00.000Z",
      ),
    ).toBeNull();
  });

  it("exports a header-only CSV for an empty audit history", () => {
    expect(serializeSignerRotationAuditCsv([])).toBe(
      SIGNER_ROTATION_AUDIT_HEADERS.join(","),
    );
  });

  it("quotes CSV fields and neutralizes spreadsheet formula cells", () => {
    const record = createSignerRotationAuditRecord(
      previous,
      {
        ...previous,
        signers: ["=FORMULA", "G-BETA"],
      },
      "@actor, admin",
      "2026-10-18T15:00:00.000Z",
    )!;

    const csv = serializeSignerRotationAuditCsv([record]);
    expect(csv).toContain('"\'=FORMULA"');
    expect(csv).toContain('"\'@actor, admin"');
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
