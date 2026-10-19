import type { GovernanceConfig, PendingTransaction, SignerQuorumProgress } from "./types";

/**
 * Compute multi-sig quorum progress for a pending transaction (#1310).
 * Pure mirror of the server/governance and on-chain views so the card can
 * render signed/required/remaining without an extra network round-trip.
 */
export function computeSignerQuorumProgress(
  transaction: Pick<PendingTransaction, "signatures" | "threshold">,
  config: Pick<GovernanceConfig, "signers">,
): SignerQuorumProgress {
  const required = Math.max(1, Math.floor(transaction.threshold || 0));
  const known = new Set(config.signers);
  const signedSet = new Set<string>();
  for (const sig of transaction.signatures) {
    if (typeof sig?.publicKey === "string" && known.has(sig.publicKey)) {
      signedSet.add(sig.publicKey);
    }
  }

  // Fallback: when config.signers is empty, count any signature present.
  if (known.size === 0) {
    for (const sig of transaction.signatures) {
      if (typeof sig?.publicKey === "string") signedSet.add(sig.publicKey);
    }
  }

  const signed = signedSet.size;
  const remaining = Math.max(0, required - signed);
  const progressPct =
    required === 0 ? 100 : Math.min(100, Math.round((signed / required) * 100));
  const met = signed >= required;

  const perSigner = (known.size > 0 ? config.signers : Array.from(signedSet)).map(
    (address) => ({ address, signed: signedSet.has(address) }),
  );

  return { signed, required, remaining, progressPct, met, perSigner };
}
