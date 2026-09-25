/**
 * Contract panic decoding for user-facing errors (#1339).
 *
 * Decoding must come from the structured `ScError` in diagnostic events, per
 * contract, and never from the RPC provider's error string.
 */
import fs from "fs";
import path from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { simulateReadOnlyCall } from "../services/sorobanReader";
import {
  decodeContractPanic,
  decodeScError,
  extractScError,
  lookupContractError,
  type ContractErrorNamespace,
} from "../../../shared/types/contractPanic";

const { xdr } = StellarSdk;

function errorEvent(scError: StellarSdk.xdr.ScError): StellarSdk.xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(scError)],
          data: xdr.ScVal.scvString("escalating error to panic"),
        }),
      ),
    }),
  });
}

const contractError = (code: number) => errorEvent(xdr.ScError.sceContract(code));
const wasmTrap = () => errorEvent(xdr.ScError.sceWasmVm(xdr.ScErrorCode.scecInvalidAction()));

describe("decodeContractPanic", () => {
  it("decodes a typed vault error from the structured ScError", () => {
    const panic = decodeContractPanic([contractError(4)], "vault");

    expect(panic).toMatchObject({
      code: "CONTRACT_ERROR",
      namespace: "vault",
      contractCode: 4,
      errorName: "InsufficientShares",
      retryable: false,
    });
  });

  it("looks codes up per contract (zap code 5 is SlippageExceeded, not vault Unauthorized)", () => {
    expect(decodeContractPanic([contractError(5)], "zap")).toMatchObject({
      code: "CONTRACT_ERROR",
      errorName: "SlippageExceeded",
      retryable: true,
    });
    expect(decodeContractPanic([contractError(5)], "vault").errorName).toBe("Unauthorized");
  });

  it("maps an untyped panic (Wasm trap) to CONTRACT_TRAPPED", () => {
    const panic = decodeContractPanic([wasmTrap()], "vault");

    expect(panic.code).toBe("CONTRACT_TRAPPED");
    expect(panic.scError).toEqual({ type: "sceWasmVm", code: "scecInvalidAction" });
  });

  it("maps host budget, auth and storage failures to stable codes", () => {
    expect(
      decodeContractPanic([errorEvent(xdr.ScError.sceBudget(xdr.ScErrorCode.scecExceededLimit()))]).code,
    ).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(
      decodeContractPanic([errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()))]).code,
    ).toBe("AUTHORIZATION_FAILED");
    expect(
      decodeContractPanic([errorEvent(xdr.ScError.sceStorage(xdr.ScErrorCode.scecMissingValue()))]).code,
    ).toBe("LEDGER_ENTRY_MISSING");
  });

  it("keeps an uncatalogued contract code instead of guessing", () => {
    expect(decodeContractPanic([contractError(9999)], "vault")).toMatchObject({
      code: "UNKNOWN_CONTRACT_ERROR",
      contractCode: 9999,
    });
    expect(decodeContractPanic([contractError(4)])).toMatchObject({
      code: "UNKNOWN_CONTRACT_ERROR",
      contractCode: 4,
    });
  });

  it("returns UNDECODABLE when there is no structured error", () => {
    expect(decodeContractPanic(undefined, "vault").code).toBe("UNDECODABLE");
    expect(decodeContractPanic([], "vault").code).toBe("UNDECODABLE");
    expect(decodeContractPanic([{ not: "an event" }], "vault").code).toBe("UNDECODABLE");
  });

  it("prefers the contract's own typed error over an earlier host error", () => {
    expect(extractScError([wasmTrap(), contractError(7)])).toEqual({
      type: "sceContract",
      contractCode: 7,
    });
  });

  it("is deterministic for the same input", () => {
    const events = [contractError(10)];
    expect(decodeContractPanic(events, "vault")).toEqual(decodeContractPanic(events, "vault"));
    expect(decodeScError(null)).toEqual(decodeScError(undefined));
  });
});

describe("contract error catalog parity", () => {
  const sources: Record<ContractErrorNamespace, { file: string; enumName: string }> = {
    vault: { file: "yield_vault/src/lib.rs", enumName: "VaultError" },
    zap: { file: "zap/src/lib.rs", enumName: "ZapError" },
  };

  it.each(Object.entries(sources))(
    "catalogues every %s error variant declared in the contract",
    (namespace, { file, enumName }) => {
      const source = fs.readFileSync(path.join(__dirname, "../../../contracts", file), "utf8");
      const body = new RegExp(`pub enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
      const variants = [...body.matchAll(/^\s*(\w+)\s*=\s*(\d+),/gm)].map(([, name, code]) => ({
        name,
        code: Number(code),
      }));

      expect(variants.length).toBeGreaterThan(0);
      for (const { name, code } of variants) {
        expect(lookupContractError(namespace as ContractErrorNamespace, code)?.name).toBe(name);
      }
    },
  );
});

describe("simulateReadOnlyCall contract errors", () => {
  const prevSim = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  const source = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  const contractId = StellarSdk.StrKey.encodeContract(Buffer.alloc(32, 7));

  function mockSimulationError(error: string, events: StellarSdk.xdr.DiagnosticEvent[]) {
    jest
      .spyOn(StellarSdk.rpc.Server.prototype, "getAccount")
      .mockResolvedValue(new StellarSdk.Account(source, "1"));
    jest.spyOn(StellarSdk.rpc.Server.prototype, "simulateTransaction").mockResolvedValue(
      StellarSdk.rpc.parseRawSimulation({
        id: "1",
        latestLedger: 100,
        error,
        events: events.map((event) => event.toXDR("base64")),
      }),
    );
  }

  beforeEach(() => {
    process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = source;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (prevSim !== undefined) process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT = prevSim;
    else delete process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  });

  it("attaches the decoded panic and keeps the raw message for existing callers", async () => {
    // The provider string names a different code on purpose: decoding must
    // follow the structured diagnostic event, not the text.
    mockSimulationError("HostError: Error(Contract, #4)", [contractError(5)]);

    const outcome = await simulateReadOnlyCall(contractId, "quote", [], { errorNamespace: "zap" });

    expect(outcome).toMatchObject({
      ok: false,
      reason: "contract_error",
      message: "HostError: Error(Contract, #4)",
      panic: { code: "CONTRACT_ERROR", contractCode: 5, errorName: "SlippageExceeded" },
    });
  });

  it("reports an untyped panic as CONTRACT_TRAPPED", async () => {
    mockSimulationError("HostError: Error(WasmVm, InvalidAction)", [wasmTrap()]);

    const outcome = await simulateReadOnlyCall(contractId, "quote");

    expect(outcome).toMatchObject({ ok: false, reason: "contract_error", panic: { code: "CONTRACT_TRAPPED" } });
  });

  it("falls back to UNDECODABLE when the simulation carries no diagnostic events", async () => {
    mockSimulationError("simulation failed", []);

    const outcome = await simulateReadOnlyCall(contractId, "quote", [], { errorNamespace: "vault" });

    expect(outcome).toMatchObject({ ok: false, reason: "contract_error", panic: { code: "UNDECODABLE" } });
  });
});
