import * as StellarSdk from '@stellar/stellar-sdk';
import { Request, Response } from 'express';
import {
  recordRelayStart,
  recordRelaySuccess,
  recordRelayFailure,
  isHashSeen,
  isFingerprintSeen,
  recordFingerprint,
} from '../services/relayerStatusService';
import { computeTransactionFingerprint } from '../utils/transactionFingerprint';

// In a real app, this would be in an environment variable
const RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY || 'SAH2...'; // Replace with a valid secret for local dev if needed
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

export const signFeeBump = async (req: Request, res: Response) => {
  const { innerTxXdr } = req.body;

  if (!innerTxXdr) {
    return res.status(400).json({ error: 'Missing innerTxXdr' });
  }

  const relayId = recordRelayStart();
  const startMs = Date.now();

  try {
    // Replay protection: hash the XDR to detect duplicates
    const xdrHash = StellarSdk.hash(Buffer.from(innerTxXdr));
    const hashHex = xdrHash.toString('hex');

    if (isHashSeen(hashHex)) {
      const durationMs = Date.now() - startMs;
      recordRelayFailure(relayId, durationMs, 'Duplicate transaction detected');
      return res.status(409).json({ error: 'Duplicate transaction - replay protection' });
    }

    const relayerKeypair = StellarSdk.Keypair.fromSecret(RELAYER_SECRET_KEY);

    // Parse the inner transaction
    const innerTx = StellarSdk.TransactionBuilder.fromXDR(innerTxXdr, NETWORK_PASSPHRASE);

    // Deterministic fingerprint-based duplicate detection (#1319): unlike the
    // raw-XDR hash check above, this catches duplicate *economic* transactions
    // (same sender/receiver/amount/asset/memo) even if re-encoded differently.
    const fingerprint = computeTransactionFingerprintForTx(innerTx as StellarSdk.Transaction);
    if (fingerprint && isFingerprintSeen(fingerprint)) {
      const durationMs = Date.now() - startMs;
      recordRelayFailure(relayId, durationMs, 'Duplicate transaction detected (fingerprint)');
      return res.status(409).json({ error: 'Duplicate transaction - fingerprint match' });
    }

    // Create the fee bump transaction
    const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
      relayerKeypair,
      StellarSdk.BASE_FEE.toString(), // Fee to be paid by the relayer
      innerTx as StellarSdk.Transaction,
      NETWORK_PASSPHRASE
    );

    // Sign the fee bump
    feeBump.sign(relayerKeypair);

    const durationMs = Date.now() - startMs;
    const feeBumpHash = feeBump.hash().toString('hex');
    recordRelaySuccess(relayId, durationMs, hashHex, feeBumpHash);
    if (fingerprint) {
      recordFingerprint(fingerprint);
    }

    return res.json({
      success: true,
      feeBumpXdr: feeBump.toXDR()
    });
  } catch (error) {
    const durationMs = Date.now() - startMs;
    const message = error instanceof Error ? error.message : 'Unknown error';
    recordRelayFailure(relayId, durationMs, message);
    console.error('Relayer error:', error);
    return res.status(500).json({ error: 'Failed to sign fee bump' });
  }
};

/**
 * Derives a deterministic transaction fingerprint from a parsed Stellar
 * transaction's first payment operation, for duplicate-submission detection.
 *
 * Returns `undefined` when the transaction has no operations or its first
 * operation isn't a simple payment (e.g. path payments, Soroban invocations,
 * or account management ops) — fingerprinting is scoped to the common
 * relayed-payment case rather than guessing at fields for arbitrary
 * operation types.
 */
export function computeTransactionFingerprintForTx(
  tx: StellarSdk.Transaction
): string | undefined {
  const [firstOp] = tx.operations ?? [];
  if (!firstOp || firstOp.type !== 'payment') {
    return undefined;
  }

  const memoValue = tx.memo?.value;
  const memo =
    typeof memoValue === 'string'
      ? memoValue
      : memoValue != null
        ? memoValue.toString()
        : undefined;

  return computeTransactionFingerprint({
    sender: firstOp.source ?? tx.source,
    receiver: firstOp.destination,
    amount: firstOp.amount,
    asset: firstOp.asset.isNative() ? 'native' : `${firstOp.asset.getCode()}:${firstOp.asset.getIssuer()}`,
    memo,
    timestampMs: Date.now(),
  });
}
