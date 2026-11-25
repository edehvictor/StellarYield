import type { GovernanceConfig, PendingTransaction, SignerQuorumProgress } from "./types";

/**
 * Compute multi-sig quorum progress for a pending transaction (#1310, #1898).
 * Pure mirror of the server/governance and on-chain views so the card can
 * render signed/required/remaining without an extra network round-trip.
 *
 * Rounding & Boundary Calculation Policy:
 * - `threshold`: strictly checked integer. If threshold <= 0, defaults to 1.
 * - `progressPct`: Documented floor rounding (`Math.floor((signed / required) * 100)`).
 *   Near-limit signers (e.g. 999 of 1000) will yield 99% (never prematurely rounding up
 *   to 100%). Quorum progress is 100% if and only if `met` is true (signed >= required).
 * - Duplicate signatures are de-duplicated and counted at most once.
 * - Signatures from unknown addresses not in `signers` are ignored.
 */
export function computeSignerQuorumProgress(
  transaction: Pick<PendingTransaction, "signatures" | "threshold">,
  config: Pick<GovernanceConfig, "signers">,
): SignerQuorumProgress {
  const rawThreshold = transaction.threshold;
  const required =
    typeof rawThreshold === "number" && Number.isFinite(rawThreshold)
      ? Math.max(1, Math.floor(rawThreshold))
      : 1;

  const signersList = Array.isArray(config.signers) ? config.signers : [];
  const known = new Set(signersList);
  const signedSet = new Set<string>();
  const signatures = Array.isArray(transaction.signatures) ? transaction.signatures : [];

  for (const sig of signatures) {
    if (typeof sig?.publicKey === "string" && known.has(sig.publicKey)) {
      signedSet.add(sig.publicKey);
    }
  }

  // Fallback: when config.signers is empty, count any signature present.
  if (known.size === 0) {
    for (const sig of signatures) {
      if (typeof sig?.publicKey === "string" && sig.publicKey) signedSet.add(sig.publicKey);
    }
  }

  const signed = signedSet.size;
  const remaining = Math.max(0, required - signed);
  const met = signed >= required;

  // Documented rounding policy: Standard round half-up, capped at 99% until quorum is reached.
  // 100% progress is attained if and only if `met` is true (signed >= required).
  const rawPct = Math.round((signed / required) * 100);
  const progressPct =
    required === 0
      ? 100
      : met
        ? 100
        : Math.min(99, Math.max(0, rawPct));

  const perSigner = (known.size > 0 ? signersList : Array.from(signedSet)).map(
    (address) => ({ address, signed: signedSet.has(address) }),
  );

  return { signed, required, remaining, progressPct, met, perSigner };
}
