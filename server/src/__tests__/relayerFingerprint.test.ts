import * as StellarSdk from '@stellar/stellar-sdk';
import { Request, Response } from 'express';

const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

// relayer.ts reads RELAYER_SECRET_KEY as a module-level constant, so the env
// var must be set before the module is imported.
const relayerKeypairForEnv = StellarSdk.Keypair.random();
process.env.RELAYER_SECRET_KEY = relayerKeypairForEnv.secret();
process.env.NETWORK_PASSPHRASE = NETWORK_PASSPHRASE;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { signFeeBump, computeTransactionFingerprintForTx } = require('../relayer/relayer');

function buildPaymentTxXdr(opts: {
  source: StellarSdk.Keypair;
  destination: string;
  amount: string;
  memo?: string;
  sequence?: string;
}): string {
  const account = new StellarSdk.Account(opts.source.publicKey(), opts.sequence ?? '1');
  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  }).addOperation(
    StellarSdk.Operation.payment({
      destination: opts.destination,
      asset: StellarSdk.Asset.native(),
      amount: opts.amount,
    })
  );

  if (opts.memo) {
    txBuilder.addMemo(StellarSdk.Memo.text(opts.memo));
  }

  const tx = txBuilder.setTimeout(30).build();
  tx.sign(opts.source);
  return tx.toXDR();
}

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res as Response;
  });
  res.json = jest.fn().mockImplementation((body: unknown) => {
    res.body = body;
    return res as Response;
  });
  return res as Response & { statusCode?: number; body?: unknown };
}

describe('relayer duplicate transaction fingerprint detection (#1319)', () => {
  const sender = StellarSdk.Keypair.random();
  const receiver = StellarSdk.Keypair.random().publicKey();

  it('computeTransactionFingerprintForTx derives a stable fingerprint from a parsed payment tx', () => {
    const xdr1 = buildPaymentTxXdr({ source: sender, destination: receiver, amount: '10', memo: 'a' });
    const xdr2 = buildPaymentTxXdr({ source: sender, destination: receiver, amount: '10', memo: 'a', sequence: '2' });

    const tx1 = StellarSdk.TransactionBuilder.fromXDR(xdr1, NETWORK_PASSPHRASE) as StellarSdk.Transaction;
    const tx2 = StellarSdk.TransactionBuilder.fromXDR(xdr2, NETWORK_PASSPHRASE) as StellarSdk.Transaction;

    const fp1 = computeTransactionFingerprintForTx(tx1);
    const fp2 = computeTransactionFingerprintForTx(tx2);

    // Same economic transaction (sender/receiver/amount/memo) -> same fingerprint,
    // even though the sequence number (and therefore XDR/hash) differs.
    expect(fp1).toBeDefined();
    expect(fp1).toBe(fp2);
  });

  it('rejects a second submission of the same economic transaction as a duplicate', async () => {
    const uniqueReceiver = StellarSdk.Keypair.random().publicKey();
    const xdrA = buildPaymentTxXdr({ source: sender, destination: uniqueReceiver, amount: '25', memo: 'dup-test' });
    const xdrB = buildPaymentTxXdr({
      source: sender,
      destination: uniqueReceiver,
      amount: '25',
      memo: 'dup-test',
      sequence: '2', // different sequence -> different XDR hash, same economic tx
    });

    const req1 = { body: { innerTxXdr: xdrA } } as Request;
    const res1 = mockRes();
    await signFeeBump(req1, res1);
    expect(res1.status).not.toHaveBeenCalled(); // success path uses default 200
    expect(res1.body).toMatchObject({ success: true });

    const req2 = { body: { innerTxXdr: xdrB } } as Request;
    const res2 = mockRes();
    await signFeeBump(req2, res2);

    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.body).toMatchObject({ error: expect.stringContaining('Duplicate') });
  });

  it('allows two distinct transactions with different amounts through', async () => {
    const uniqueReceiver = StellarSdk.Keypair.random().publicKey();
    const xdrA = buildPaymentTxXdr({ source: sender, destination: uniqueReceiver, amount: '5', memo: 'distinct' });
    const xdrB = buildPaymentTxXdr({
      source: sender,
      destination: uniqueReceiver,
      amount: '6', // different amount -> different fingerprint
      memo: 'distinct',
      sequence: '2',
    });

    const req1 = { body: { innerTxXdr: xdrA } } as Request;
    const res1 = mockRes();
    await signFeeBump(req1, res1);
    expect(res1.body).toMatchObject({ success: true });

    const req2 = { body: { innerTxXdr: xdrB } } as Request;
    const res2 = mockRes();
    await signFeeBump(req2, res2);
    expect(res2.body).toMatchObject({ success: true });
    expect(res2.status).not.toHaveBeenCalledWith(409);
  });
});
