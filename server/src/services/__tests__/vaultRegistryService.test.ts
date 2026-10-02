import { vaultRegistryService, VaultRegistryValidationError } from "../vaultRegistryService";

describe("vaultRegistryService", () => {
  it("returns the seeded default entries for known vault ids", () => {
    const usdc = vaultRegistryService.getVault("usdc");
    expect(usdc).toBeDefined();
    expect(usdc?.name).toMatch(/USDC/);
    expect(usdc?.status).toBe("ACTIVE");
  });

  it("returns undefined for an unknown vault id with no prior update", () => {
    expect(vaultRegistryService.getVault("does-not-exist")).toBeUndefined();
  });

  it("applies a partial update to an existing vault and records the actor/timestamp", () => {
    const before = Date.now();
    const updated = vaultRegistryService.updateVault(
      "usdc",
      { status: "PAUSED" },
      "admin-1",
    );

    expect(updated.status).toBe("PAUSED");
    expect(updated.name).toBe("USDC Yield Vault"); // unchanged field preserved
    expect(updated.updatedBy).toBe("admin-1");
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("persists updates across subsequent reads", () => {
    vaultRegistryService.updateVault("xlm", { capUsd: 500_000 }, "admin-2");
    const reread = vaultRegistryService.getVault("xlm");
    expect(reread?.capUsd).toBe(500_000);
  });

  it("creates a new vault entry when a name is supplied for an unknown id", () => {
    const created = vaultRegistryService.updateVault(
      "new-vault",
      { name: "New Vault", status: "ACTIVE" },
      "admin-1",
    );
    expect(created.vaultId).toBe("new-vault");
    expect(vaultRegistryService.listVaults().some((v) => v.vaultId === "new-vault")).toBe(true);
  });

  it("rejects registering an unknown vault without a name", () => {
    expect(() =>
      vaultRegistryService.updateVault("brand-new", { status: "ACTIVE" }, "admin-1"),
    ).toThrow(VaultRegistryValidationError);
  });

  it("rejects an invalid status value", () => {
    expect(() =>
      vaultRegistryService.updateVault("usdc", { status: "BOGUS" as never }, "admin-1"),
    ).toThrow(VaultRegistryValidationError);
  });

  it("rejects a negative capUsd", () => {
    expect(() =>
      vaultRegistryService.updateVault("usdc", { capUsd: -1 }, "admin-1"),
    ).toThrow(VaultRegistryValidationError);
  });

  it("rejects an empty name", () => {
    expect(() =>
      vaultRegistryService.updateVault("usdc", { name: "   " }, "admin-1"),
    ).toThrow(VaultRegistryValidationError);
  });

  it("lists every known vault including ones seeded only by defaults", () => {
    const vaults = vaultRegistryService.listVaults();
    const ids = vaults.map((v) => v.vaultId);
    expect(ids).toEqual(expect.arrayContaining(["usdc", "xlm", "index", "bluechip"]));
  });
});
