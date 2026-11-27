/**
 * Signer quorum progress service (#1310, #1898)
 *
 * Deterministic computation of multi-sig quorum progress used by the
 * governance API. Mirrors the on-chain `get_quorum_progress` view so the
 * client can render signed/required/remaining/progressPct/met without
 * waiting for an RPC round-trip.
 *
 * Rounding & Boundary Calculation Policy:
 * - `threshold`: strictly checked integer. If threshold <= 0, defaults to 1.
 * - `progressPct`: Documented floor rounding (`Math.floor((signed / required) * 100)`).
 *   Near-limit signers (e.g. 999 of 1000) will yield 99% (never prematurely rounding up
 *   to 100%). Quorum progress is 100% if and only if `met` is true (signed >= required).
 * - Duplicate signatures are de-duplicated and counted at most once.
 * - Signatures from unknown addresses not in `signers` are ignored.
 */

export interface SignerQuorumInput {
  /** Expected signer public keys (governance config signers). */
  signers: string[];
  /** Public keys that have signed so far. */
  signatures: string[];
  /** Required signature threshold. */
  threshold: number;
}

export interface SignerQuorumProgress {
  signed: number;
  required: number;
  remaining: number;
  /** Progress toward quorum as a percentage 0–100. */
  progressPct: number;
  met: boolean;
  perSigner: { address: string; signed: boolean }[];
}

/**
 * Compute quorum progress for a set of signers/signatures.
 *
 * Edge cases:
 * - Duplicate signatures are counted once.
 * - Signatures from addresses not in `signers` are ignored.
 * - `threshold <= 0` is treated as 1; threshold > signers.length is allowed
 *   (met only when enough unique known signatures exist).
 * - Empty signers list yields a zeroed, non-met progress with required =
 *   max(threshold, 1).
 * - Progress percentage uses documented floor rounding: progressPct reaches 100%
 *   if and only if signed >= required.
 */
export function computeSignerQuorumProgress(
  input: SignerQuorumInput,
): SignerQuorumProgress {
  const signers = Array.isArray(input.signers)
    ? input.signers.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  const required =
    typeof input.threshold === "number" && Number.isFinite(input.threshold)
      ? Math.max(1, Math.floor(input.threshold))
      : 1;

  const known = new Set(signers);
  const signedSet = new Set<string>();
  for (const sig of Array.isArray(input.signatures) ? input.signatures : []) {
    if (typeof sig === "string" && sig.length > 0 && known.has(sig)) {
      signedSet.add(sig);
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

  const perSigner = signers.map((address) => ({
    address,
    signed: signedSet.has(address),
  }));

  return { signed, required, remaining, progressPct, met, perSigner };
}
