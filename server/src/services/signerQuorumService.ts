/**
 * Signer quorum progress service (#1310)
 *
 * Deterministic computation of multi-sig quorum progress used by the
 * governance API. Mirrors the on-chain `get_quorum_progress` view so the
 * client can render signed/required/remaining/progressPct/met without
 * waiting for an RPC round-trip.
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
 *   max(threshold, 0).
 */
export function computeSignerQuorumProgress(
  input: SignerQuorumInput,
): SignerQuorumProgress {
  const signers = Array.isArray(input.signers) ? input.signers.filter(Boolean) : [];
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
  const progressPct =
    required === 0
      ? 100
      : Math.min(100, Math.round((signed / required) * 100));
  const met = signed >= required;

  const perSigner = signers.map((address) => ({
    address,
    signed: signedSet.has(address),
  }));

  return { signed, required, remaining, progressPct, met, perSigner };
}
