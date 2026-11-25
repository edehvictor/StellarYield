import * as StellarSdk from '@stellar/stellar-sdk';
import { Request, Response } from 'express';
import { createTransactionReviewContext, validateTransactionReviewContext, type NetworkPassphrase } from '../services/transactionReviewContext';
import {
  recordRelayStart,
  recordRelaySuccess,
  recordRelayFailure,
  isHashSeen,
} from '../services/relayerStatusService';

// In a real app, this would be in an environment variable
const RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY || 'SAH2...'; // Replace with a valid secret for local dev if needed
const NETWORK_PASSPHRASE: NetworkPassphrase = process.env.NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET as NetworkPassphrase;
/** Captures the review context from the request for validation during execution. */
export interface RelayRequest {
  innerTxXdr: string;
  reviewContext?: {
    networkPassphrase: NetworkPassphrase;
    rpcUrl: string;
    ledgerSequence: number;
    transactionVersion: string;
  };
};

export const signFeeBump = async (req: Request, res: Response) => {
  const { innerTxXdr, reviewContext } = req.body;

  if (!innerTxXdr) {
    return res.status(400).json({ error: 'Missing innerTxXdr' });
  }

  // ── Capture and validate review context ───────────────────────────────
  const capturedContext = reviewContext
    ? createTransactionReviewContext(
        reviewContext.networkPassphrase,
        reviewContext.rpcUrl,
        reviewContext.ledgerSequence,
        reviewContext.transactionVersion,
      )
    : null;

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

    // Validate context if provided
    if (capturedContext) {
      const validationError = validateTransactionReviewContext(
        capturedContext,
        createTransactionReviewContext(
          NETWORK_PASSPHRASE,
          process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
          0,
          'pending'
        )
      );
      if (validationError) {
        recordRelayFailure(relayId, 0, `Context validation: ${validationError}`);
        return res.status(400).json({
          error: `Context validation failed: ${validationError}`,
          code: 'CONTEXT_VALIDATION_ERROR',
        });
      }
    }

    const relayerKeypair = StellarSdk.Keypair.fromSecret(RELAYER_SECRET_KEY);

    // Parse the inner transaction
    const innerTx = StellarSdk.TransactionBuilder.fromXDR(innerTxXdr, NETWORK_PASSPHRASE);

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
