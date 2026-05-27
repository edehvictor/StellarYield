import { describe, it, expect } from "vitest";
import {
  validateAddress,
  validateNumber,
  getRiskLevel,
  validateTransactionBuilder,
} from "./validation";
import type { AdminActionOption } from "./types";

describe("validateAddress", () => {
  it("accepts valid Stellar address", () => {
    expect(
      validateAddress("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    ).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateAddress("")).toBe(false);
  });

  it("rejects address not starting with G", () => {
    expect(
      validateAddress("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
    ).toBe(false);
  });

  it("rejects address with wrong length", () => {
    expect(validateAddress("GSHORT")).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(
      validateAddress("G!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!WHF"),
    ).toBe(false);
  });
});

describe("validateNumber", () => {
  it("accepts valid positive number", () => {
    expect(validateNumber("100")).toBe(true);
  });

  it("accepts zero", () => {
    expect(validateNumber("0")).toBe(true);
  });

  it("rejects negative number", () => {
    expect(validateNumber("-100")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateNumber("")).toBe(false);
  });

  it("rejects non-numeric string", () => {
    expect(validateNumber("abc")).toBe(false);
  });

  it("validates minimum bound", () => {
    expect(validateNumber("50", 100)).toBe(false);
    expect(validateNumber("100", 100)).toBe(true);
    expect(validateNumber("150", 100)).toBe(true);
  });

  it("validates maximum bound", () => {
    expect(validateNumber("150", undefined, 100)).toBe(false);
    expect(validateNumber("100", undefined, 100)).toBe(true);
    expect(validateNumber("50", undefined, 100)).toBe(true);
  });

  it("validates both min and max bounds", () => {
    expect(validateNumber("50", 100, 200)).toBe(false);
    expect(validateNumber("150", 100, 200)).toBe(true);
    expect(validateNumber("250", 100, 200)).toBe(false);
  });
});

describe("getRiskLevel", () => {
  it("returns critical for emergency_pause", () => {
    expect(getRiskLevel("emergency_pause")).toBe("critical");
  });

  it("returns critical for emergency_unpause", () => {
    expect(getRiskLevel("emergency_unpause")).toBe("critical");
  });

  it("returns critical for rescue_funds", () => {
    expect(getRiskLevel("rescue_funds")).toBe("critical");
  });

  it("returns critical for set_admin", () => {
    expect(getRiskLevel("set_admin")).toBe("critical");
  });

  it("returns high for remove_keeper", () => {
    expect(getRiskLevel("remove_keeper")).toBe("high");
  });

  it("returns high for set_fee_bounds", () => {
    expect(getRiskLevel("set_fee_bounds")).toBe("high");
  });

  it("returns medium for register_keeper", () => {
    expect(getRiskLevel("register_keeper")).toBe("medium");
  });

  it("returns medium for set_keeper_fee", () => {
    expect(getRiskLevel("set_keeper_fee")).toBe("medium");
  });
});

describe("validateTransactionBuilder", () => {
  const validWallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  it("returns null when no action is provided", () => {
    const result = validateTransactionBuilder(undefined, validWallet, {});
    expect(result).toBeNull();
  });

  it("returns null when no wallet is provided", () => {
    const action: AdminActionOption = {
      label: "Emergency Pause",
      method: "emergency_pause",
      description: "Pause operations",
      fields: [],
    };
    const result = validateTransactionBuilder(action, null, {});
    expect(result).toBeNull();
  });

  it("validates emergency pause with no fields", () => {
    const action: AdminActionOption = {
      label: "Emergency Pause",
      method: "emergency_pause",
      description: "Pause operations",
      fields: [],
    };
    const result = validateTransactionBuilder(action, validWallet, {});
    expect(result?.isValid).toBe(true);
    expect(result?.errors).toHaveLength(0);
    expect(result?.action).toBe("Emergency Pause");
    expect(result?.risk).toBe("critical");
  });

  it("validates register keeper with valid address", () => {
    const action: AdminActionOption = {
      label: "Register Keeper",
      method: "register_keeper",
      description: "Add keeper",
      fields: [
        {
          name: "keeper",
          label: "Keeper Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      keeper: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(result?.isValid).toBe(true);
    expect(result?.target).toContain("GBBBBBB");
  });

  it("rejects register keeper with invalid address", () => {
    const action: AdminActionOption = {
      label: "Register Keeper",
      method: "register_keeper",
      description: "Add keeper",
      fields: [
        {
          name: "keeper",
          label: "Keeper Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      keeper: "INVALID",
    });
    expect(result?.isValid).toBe(false);
    expect(result?.errors).toHaveLength(1);
    expect(result?.errors[0].message).toContain("valid Stellar address");
  });

  it("rejects register keeper with missing required field", () => {
    const action: AdminActionOption = {
      label: "Register Keeper",
      method: "register_keeper",
      description: "Add keeper",
      fields: [
        {
          name: "keeper",
          label: "Keeper Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {});
    expect(result?.isValid).toBe(false);
    expect(result?.errors).toHaveLength(1);
    expect(result?.errors[0].message).toContain("required");
  });

  it("validates set_keeper_fee with valid fee", () => {
    const action: AdminActionOption = {
      label: "Set Keeper Fee",
      method: "set_keeper_fee",
      description: "Update fee",
      fields: [
        {
          name: "fee_bps",
          label: "Fee (bps)",
          type: "number",
          placeholder: "50",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      fee_bps: "75",
    });
    expect(result?.isValid).toBe(true);
    expect(result?.target).toBe("75 bps");
  });

  it("rejects set_keeper_fee with fee > 10000", () => {
    const action: AdminActionOption = {
      label: "Set Keeper Fee",
      method: "set_keeper_fee",
      description: "Update fee",
      fields: [
        {
          name: "fee_bps",
          label: "Fee (bps)",
          type: "number",
          placeholder: "50",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      fee_bps: "15000",
    });
    expect(result?.isValid).toBe(false);
    expect(result?.errors[0].message).toContain("between 0 and 10000");
  });

  it("validates set_fee_bounds with min < max", () => {
    const action: AdminActionOption = {
      label: "Set Fee Bounds",
      method: "set_fee_bounds",
      description: "Update bounds",
      fields: [
        {
          name: "min_bps",
          label: "Min Fee (bps)",
          type: "number",
          placeholder: "100",
          required: true,
        },
        {
          name: "max_bps",
          label: "Max Fee (bps)",
          type: "number",
          placeholder: "1000",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      min_bps: "100",
      max_bps: "1000",
    });
    expect(result?.isValid).toBe(true);
    expect(result?.target).toBe("100-1000 bps");
  });

  it("rejects set_fee_bounds with min >= max", () => {
    const action: AdminActionOption = {
      label: "Set Fee Bounds",
      method: "set_fee_bounds",
      description: "Update bounds",
      fields: [
        {
          name: "min_bps",
          label: "Min Fee (bps)",
          type: "number",
          placeholder: "100",
          required: true,
        },
        {
          name: "max_bps",
          label: "Max Fee (bps)",
          type: "number",
          placeholder: "1000",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      min_bps: "1000",
      max_bps: "500",
    });
    expect(result?.isValid).toBe(false);
    expect(result?.errors.some((e) => e.message.includes("greater than min"))).toBe(
      true,
    );
  });

  it("validates rescue_funds with valid inputs", () => {
    const action: AdminActionOption = {
      label: "Rescue Funds",
      method: "rescue_funds",
      description: "Transfer funds",
      fields: [
        {
          name: "target",
          label: "Target Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
        {
          name: "amount",
          label: "Amount (stroops)",
          type: "number",
          placeholder: "1000000",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      target: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      amount: "5000000",
    });
    expect(result?.isValid).toBe(true);
    expect(result?.target).toContain("GCCCCCC");
  });

  it("rejects rescue_funds with zero amount", () => {
    const action: AdminActionOption = {
      label: "Rescue Funds",
      method: "rescue_funds",
      description: "Transfer funds",
      fields: [
        {
          name: "target",
          label: "Target Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
        {
          name: "amount",
          label: "Amount (stroops)",
          type: "number",
          placeholder: "1000000",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      target: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      amount: "0",
    });
    expect(result?.isValid).toBe(false);
    expect(result?.errors[0].message).toContain("greater than 0");
  });

  it("validates set_admin with valid address", () => {
    const action: AdminActionOption = {
      label: "Set Admin",
      method: "set_admin",
      description: "Transfer admin",
      fields: [
        {
          name: "new_admin",
          label: "New Admin Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      new_admin: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    });
    expect(result?.isValid).toBe(true);
    expect(result?.target).toContain("GDDDDDD");
    expect(result?.risk).toBe("critical");
  });

  it("accumulates multiple validation errors", () => {
    const action: AdminActionOption = {
      label: "Rescue Funds",
      method: "rescue_funds",
      description: "Transfer funds",
      fields: [
        {
          name: "target",
          label: "Target Address",
          type: "address",
          placeholder: "G...",
          required: true,
        },
        {
          name: "amount",
          label: "Amount (stroops)",
          type: "number",
          placeholder: "1000000",
          required: true,
        },
      ],
    };
    const result = validateTransactionBuilder(action, validWallet, {
      target: "INVALID",
      amount: "-100",
    });
    expect(result?.isValid).toBe(false);
    expect(result?.errors.length).toBeGreaterThan(1);
  });
});
