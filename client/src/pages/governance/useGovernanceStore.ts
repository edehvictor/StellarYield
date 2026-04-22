import { useState, useCallback } from "react";
import type { PendingTransaction, GovernanceConfig } from "./types";

const STORAGE_KEY = "stellar_yield_governance_txns";
const CONFIG_KEY = "stellar_yield_governance_config";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return JSON.parse(stored) as T;
  } catch {
    // Ignore parse errors
  }
  return fallback;
}

function saveToStorage<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

const DEFAULT_CONFIG: GovernanceConfig = {
  signers: [],
  threshold: 3,
  contractId: import.meta.env.VITE_CONTRACT_ID ?? "",
};

export function useGovernanceStore() {
  const [transactions, setTransactions] = useState<PendingTransaction[]>(() =>
    loadFromStorage(STORAGE_KEY, []),
  );
  const [config, setConfig] = useState<GovernanceConfig>(() =>
    loadFromStorage(CONFIG_KEY, DEFAULT_CONFIG),
  );

  const addTransaction = useCallback(
    (tx: PendingTransaction) => {
      const updated = [...transactions, tx];
      setTransactions(updated);
      saveToStorage(STORAGE_KEY, updated);
    },
    [transactions],
  );

  const addSignature = useCallback(
    (txId: string, publicKey: string) => {
      const updated = transactions.map((tx) => {
        if (tx.id !== txId) return tx;

        const alreadySigned = tx.signatures.some((s) => s.publicKey === publicKey);
        if (alreadySigned) return tx;

        const newSignatures = [
          ...tx.signatures,
          { publicKey, signedAt: Date.now() },
        ];
        const newStatus =
          newSignatures.length >= tx.threshold ? "ready" : "pending";

        return { ...tx, signatures: newSignatures, status: newStatus } as PendingTransaction;
      });

      setTransactions(updated);
      saveToStorage(STORAGE_KEY, updated);
    },
    [transactions],
  );

  const markExecuted = useCallback(
    (txId: string) => {
      const updated = transactions.map((tx) =>
        tx.id === txId ? { ...tx, status: "executed" as const } : tx,
      );
      setTransactions(updated);
      saveToStorage(STORAGE_KEY, updated);
    },
    [transactions],
  );

  const updateConfig = useCallback((newConfig: GovernanceConfig) => {
    setConfig(newConfig);
    saveToStorage(CONFIG_KEY, newConfig);
  }, []);

  return {
    transactions,
    config,
    addTransaction,
    addSignature,
    markExecuted,
    updateConfig,
  };
}
