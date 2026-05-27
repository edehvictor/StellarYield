import { useState, useMemo } from "react";
import * as StellarSdk from "@stellar/stellar-sdk";
import { useWallet } from "../../context/useWallet";
import { ADMIN_ACTIONS } from "./governanceActions";
import type { AdminAction, PendingTransaction } from "./types";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { validateTransactionBuilder } from "./validation";

interface TransactionBuilderProps {
  threshold: number;
  contractId: string;
  onTransactionCreated: (tx: PendingTransaction) => void;
}

const RPC_URL =
  import.meta.env.VITE_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  import.meta.env.VITE_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";

async function getRecommendedBaseFee(): Promise<string> {
  try {
    const response = await fetch("/api/fees");
    if (!response.ok) return StellarSdk.BASE_FEE;
    const payload = (await response.json()) as {
      fees?: { average?: number };
    };
    const fee = payload.fees?.average;
    if (!fee || !Number.isFinite(fee) || fee <= 0) return StellarSdk.BASE_FEE;
    return String(Math.round(fee));
  } catch {
    return StellarSdk.BASE_FEE;
  }
}

export default function TransactionBuilder({
  threshold,
  contractId,
  onTransactionCreated,
}: TransactionBuilderProps) {
  const { walletAddress } = useWallet();
  const [selectedAction, setSelectedAction] = useState<AdminAction | "">("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const action = ADMIN_ACTIONS.find((a) => a.method === selectedAction);

  const validationSummary = useMemo(
    () => validateTransactionBuilder(action, walletAddress, fieldValues),
    [action, walletAddress, fieldValues],
  );

  async function handleBuild() {
    if (!walletAddress || !action || !contractId) return;

    setBuilding(true);
    setError(null);

    try {
      const server = new StellarSdk.rpc.Server(RPC_URL);
      const contract = new StellarSdk.Contract(contractId);
      const source = await server.getAccount(walletAddress);
      const baseFee = await getRecommendedBaseFee();

      // Build ScVal args: admin address + action-specific fields
      const args: StellarSdk.xdr.ScVal[] = [
        new StellarSdk.Address(walletAddress).toScVal(),
      ];

      for (const field of action.fields) {
        const value = fieldValues[field.name] ?? "";
        if (field.required && !value) {
          setError(`${field.label} is required`);
          setBuilding(false);
          return;
        }
        if (field.type === "address") {
          args.push(new StellarSdk.Address(value).toScVal());
        } else if (field.type === "number") {
          args.push(
            StellarSdk.nativeToScVal(BigInt(value), { type: "i128" }),
          );
        }
      }

      const tx = new StellarSdk.TransactionBuilder(source, {
        fee: baseFee,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(action.method, ...args))
        .setTimeout(86400) // 24h expiry for multi-sig collection
        .build();

      const simulated = await server.simulateTransaction(tx);

      if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
        const errResp =
          simulated as StellarSdk.rpc.Api.SimulateTransactionErrorResponse;
        throw new Error(`Simulation failed: ${errResp.error}`);
      }

      const assembled = StellarSdk.rpc.assembleTransaction(
        tx,
        simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse,
      ).build();

      const xdr = assembled.toXDR();

      const pendingTx: PendingTransaction = {
        id: crypto.randomUUID(),
        description: `${action.label} - proposed by ${walletAddress.slice(0, 8)}...`,
        method: action.method,
        args: action.fields.map((f) => fieldValues[f.name] ?? ""),
        xdr,
        signatures: [],
        threshold,
        createdAt: Date.now(),
        createdBy: walletAddress,
        status: "pending",
      };

      onTransactionCreated(pendingTx);
      setSelectedAction("");
      setFieldValues({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="glass-card p-6">
      <h3 className="text-lg font-bold mb-4">Propose Admin Action</h3>

      <div className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Action</label>
          <select
            value={selectedAction}
            onChange={(e) => {
              setSelectedAction(e.target.value as AdminAction);
              setFieldValues({});
              setError(null);
            }}
            className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-4 py-2 text-white"
          >
            <option value="">Select an action...</option>
            {ADMIN_ACTIONS.map((a) => (
              <option key={a.method} value={a.method}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        {action && (
          <>
            <p className="text-sm text-gray-400">{action.description}</p>

            {action.fields.map((field) => (
              <div key={field.name}>
                <label className="block text-sm text-gray-400 mb-1">
                  {field.label}
                </label>
                <input
                  type={field.type === "number" ? "number" : "text"}
                  placeholder={field.placeholder}
                  value={fieldValues[field.name] ?? ""}
                  onChange={(e) =>
                    setFieldValues((prev) => ({
                      ...prev,
                      [field.name]: e.target.value,
                    }))
                  }
                  className="w-full bg-[#1a1a2e] border border-gray-700 rounded-lg px-4 py-2 text-white"
                />
              </div>
            ))}

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            {validationSummary && (
              <div
                className={`border rounded-lg p-4 ${
                  validationSummary.isValid
                    ? "border-green-500/30 bg-green-500/5"
                    : "border-red-500/30 bg-red-500/5"
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {validationSummary.isValid ? (
                    <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1">
                    <h4 className="font-semibold text-sm mb-1">
                      {validationSummary.isValid
                        ? "Ready to Build"
                        : "Validation Required"}
                    </h4>
                    {validationSummary.errors.length > 0 && (
                      <ul className="text-sm text-red-400 space-y-1">
                        {validationSummary.errors.map((err, idx) => (
                          <li key={idx}>• {err.message}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {validationSummary.isValid && (
                  <div className="space-y-2 text-sm border-t border-gray-700 pt-3">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Action:</span>
                      <span className="font-medium">{validationSummary.action}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Target:</span>
                      <span className="font-medium">{validationSummary.target}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">Risk Level:</span>
                      <span
                        className={`flex items-center gap-1 font-medium ${
                          validationSummary.risk === "critical"
                            ? "text-red-400"
                            : validationSummary.risk === "high"
                            ? "text-orange-400"
                            : validationSummary.risk === "medium"
                            ? "text-yellow-400"
                            : "text-green-400"
                        }`}
                      >
                        {validationSummary.risk === "critical" ||
                        validationSummary.risk === "high" ? (
                          <AlertTriangle className="w-4 h-4" />
                        ) : null}
                        {validationSummary.risk.toUpperCase()}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleBuild}
              disabled={building || !walletAddress || !validationSummary?.isValid}
              className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 text-white font-semibold py-3 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {building ? "Building Transaction..." : "Build & Propose"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
