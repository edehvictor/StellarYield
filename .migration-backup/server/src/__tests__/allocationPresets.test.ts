import {
  validatePreset,
  createPreset,
  getPresetsForWallet,
  getPreset,
  updatePreset,
  deletePreset,
  type PresetAllocation,
} from "../services/allocationPresetsService";

const WALLET = "GBTEST1234567890";
const VALID_ALLOCATIONS: PresetAllocation[] = [
  { vaultId: "blend", vaultName: "Blend", percentage: 60 },
  { vaultId: "soroswap", vaultName: "Soroswap", percentage: 40 },
];

describe("validatePreset", () => {
  it("accepts valid input", () => {
    const result = validatePreset(WALLET, "My Preset", VALID_ALLOCATIONS);
    expect(result.ok).toBe(true);
  });

  it("rejects empty walletAddress", () => {
    const result = validatePreset("", "My Preset", VALID_ALLOCATIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "walletAddress")).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const result = validatePreset(WALLET, "", VALID_ALLOCATIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "name")).toBe(true);
    }
  });

  it("rejects allocations not summing to 100", () => {
    const bad: PresetAllocation[] = [
      { vaultId: "blend", vaultName: "Blend", percentage: 50 },
      { vaultId: "soroswap", vaultName: "Soroswap", percentage: 30 },
    ];
    const result = validatePreset(WALLET, "Bad", bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field === "allocations")).toBe(true);
    }
  });

  it("rejects unsupported vaultId", () => {
    const bad: PresetAllocation[] = [
      { vaultId: "unknown-vault", vaultName: "Unknown", percentage: 100 },
    ];
    const result = validatePreset(WALLET, "Bad", bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.field.includes("vaultId"))).toBe(true);
    }
  });

  it("rejects percentage > 100", () => {
    const bad: PresetAllocation[] = [
      { vaultId: "blend", vaultName: "Blend", percentage: 150 },
    ];
    const result = validatePreset(WALLET, "Bad", bad);
    expect(result.ok).toBe(false);
  });
});

describe("createPreset", () => {
  it("returns a preset with id, walletAddress, and timestamps", () => {
    const preset = createPreset(WALLET, "Test", VALID_ALLOCATIONS);
    expect(preset.id).toBeTruthy();
    expect(preset.walletAddress).toBe(WALLET);
    expect(preset.name).toBe("Test");
    expect(preset.createdAt).toBeTruthy();
    expect(preset.updatedAt).toBeTruthy();
  });

  it("stores the preset for later retrieval", () => {
    const preset = createPreset(WALLET, "Stored", VALID_ALLOCATIONS);
    expect(getPreset(WALLET, preset.id)).toMatchObject({ id: preset.id });
  });
});

describe("getPresetsForWallet", () => {
  it("returns only presets for the given wallet", () => {
    const other = "GOTHER1234567890";
    const p1 = createPreset(WALLET, "P1", VALID_ALLOCATIONS);
    createPreset(other, "Other", VALID_ALLOCATIONS);
    const presets = getPresetsForWallet(WALLET);
    expect(presets.some((p) => p.id === p1.id)).toBe(true);
    expect(presets.every((p) => p.walletAddress === WALLET)).toBe(true);
  });
});

describe("updatePreset", () => {
  it("updates name and allocations", () => {
    const preset = createPreset(WALLET, "Original", VALID_ALLOCATIONS);
    const newAllocs: PresetAllocation[] = [
      { vaultId: "blend", vaultName: "Blend", percentage: 100 },
    ];
    const updated = updatePreset(WALLET, preset.id, "Updated", newAllocs);
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(updated!.allocations[0].percentage).toBe(100);
  });

  it("returns null for non-existent preset", () => {
    expect(updatePreset(WALLET, "nonexistent", "X", VALID_ALLOCATIONS)).toBeNull();
  });

  it("updated preset retains the same id", () => {
    const preset = createPreset(WALLET, "Pre", VALID_ALLOCATIONS);
    const updated = updatePreset(WALLET, preset.id, "Post", VALID_ALLOCATIONS);
    expect(updated!.id).toBe(preset.id);
    expect(updated!.walletAddress).toBe(WALLET);
  });
});

describe("deletePreset", () => {
  it("deletes an existing preset", () => {
    const preset = createPreset(WALLET, "Del", VALID_ALLOCATIONS);
    expect(deletePreset(WALLET, preset.id)).toBe(true);
    expect(getPreset(WALLET, preset.id)).toBeUndefined();
  });

  it("returns false for non-existent preset", () => {
    expect(deletePreset(WALLET, "ghost")).toBe(false);
  });
});
