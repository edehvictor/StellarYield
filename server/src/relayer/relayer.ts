import * as StellarSdk from '@stellar/stellar-sdk';
import { Request, Response } from 'express';

// In a real app, this would be in an environment variable
const RELAYER_SECRET_KEY = process.env.RELAYER_SECRET_KEY || 'SAH2...'; // Replace with a valid secret for local dev if needed
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;

export const signFeeBump = async (req: Request, res: Response) => {
  const { innerTxXdr } = req.body;

  if (!innerTxXdr) {
    return res.status(400).json({ error: 'Missing innerTxXdr' });
  }

  try {
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

    return res.json({
      success: true,
      feeBumpXdr: feeBump.toXDR()
    });
  } catch (error) {
    console.error('Relayer error:', error);
    return res.status(500).json({ error: 'Failed to sign fee bump' });
  }
};
