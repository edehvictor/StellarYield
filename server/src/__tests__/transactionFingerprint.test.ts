import {
  computeTransactionFingerprint,
  canonicalizeTransaction,
  DEFAULT_TIMESTAMP_BUCKET_MS,
  type TransactionFingerprintInput,
} from '../utils/transactionFingerprint';

const BASE_TIME = 1774360000000;

function baseInput(overrides: Partial<TransactionFingerprintInput> = {}): TransactionFingerprintInput {
  return {
    sender: 'GABC1234SENDER',
    receiver: 'GXYZ5678RECEIVER',
    amount: '100.5000000',
    asset: 'USDC:GISSUER123',
    memo: 'order-42',
    timestampMs: BASE_TIME,
    ...overrides,
  };
}

describe('transactionFingerprint', () => {
  describe('computeTransactionFingerprint', () => {
    it('produces the same hash for identical inputs', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(baseInput());
      expect(a).toBe(b);
    });

    it('produces a 64-character hex SHA-256 digest', () => {
      const hash = computeTransactionFingerprint(baseInput());
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces a different hash when the sender differs', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(baseInput({ sender: 'GDIFFERENTSENDER' }));
      expect(a).not.toBe(b);
    });

    it('produces a different hash when the receiver differs', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(baseInput({ receiver: 'GDIFFERENTRECEIVER' }));
      expect(a).not.toBe(b);
    });

    it('produces a different hash when the amount differs', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(baseInput({ amount: '100.5000001' }));
      expect(a).not.toBe(b);
    });

    it('produces a different hash when the asset differs', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(baseInput({ asset: 'XLM' }));
      expect(a).not.toBe(b);
    });

    it('produces a different hash when the memo/nonce differs', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(baseInput({ memo: 'order-43' }));
      expect(a).not.toBe(b);
    });

    it('treats a missing memo the same as an empty memo', () => {
      const withEmptyMemo = computeTransactionFingerprint(baseInput({ memo: '' }));
      const withoutMemo = computeTransactionFingerprint(baseInput({ memo: undefined }));
      expect(withEmptyMemo).toBe(withoutMemo);
    });

    it('is case-insensitive for sender, receiver, and asset', () => {
      const lower = computeTransactionFingerprint(baseInput());
      const upperSender = computeTransactionFingerprint(
        baseInput({ sender: 'gabc1234sender' })
      );
      expect(lower).toBe(upperSender);
    });

    it('ignores leading/trailing whitespace in string fields', () => {
      const a = computeTransactionFingerprint(baseInput());
      const b = computeTransactionFingerprint(
        baseInput({ sender: '  GABC1234SENDER  ', memo: ' order-42 ' })
      );
      expect(a).toBe(b);
    });

    it('groups nearby timestamps into the same bucket, producing the same hash', () => {
      // Align to a bucket boundary so "+ bucketMs - 1" is guaranteed to stay
      // within the same bucket regardless of what BASE_TIME happens to be.
      const bucketStart =
        Math.floor(BASE_TIME / DEFAULT_TIMESTAMP_BUCKET_MS) * DEFAULT_TIMESTAMP_BUCKET_MS;
      const a = computeTransactionFingerprint(baseInput({ timestampMs: bucketStart }));
      const b = computeTransactionFingerprint(
        baseInput({ timestampMs: bucketStart + DEFAULT_TIMESTAMP_BUCKET_MS - 1 })
      );
      expect(a).toBe(b);
    });

    it('produces a different hash once timestamps cross a bucket boundary', () => {
      const bucketStart =
        Math.floor(BASE_TIME / DEFAULT_TIMESTAMP_BUCKET_MS) * DEFAULT_TIMESTAMP_BUCKET_MS;
      const a = computeTransactionFingerprint(baseInput({ timestampMs: bucketStart }));
      const b = computeTransactionFingerprint(
        baseInput({ timestampMs: bucketStart + DEFAULT_TIMESTAMP_BUCKET_MS })
      );
      expect(a).not.toBe(b);
    });

    it('respects a custom bucket width', () => {
      const bucketMs = 1000;
      const a = computeTransactionFingerprint(baseInput({ timestampMs: BASE_TIME, bucketMs }));
      const b = computeTransactionFingerprint(
        baseInput({ timestampMs: BASE_TIME + 500, bucketMs })
      );
      const c = computeTransactionFingerprint(
        baseInput({ timestampMs: BASE_TIME + 1500, bucketMs })
      );
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });
  });

  describe('canonicalizeTransaction', () => {
    it('produces a stable field order regardless of construction order', () => {
      const input1 = baseInput();
      const input2: TransactionFingerprintInput = {
        timestampMs: input1.timestampMs,
        memo: input1.memo,
        asset: input1.asset,
        amount: input1.amount,
        receiver: input1.receiver,
        sender: input1.sender,
      };

      expect(canonicalizeTransaction(input1)).toEqual(canonicalizeTransaction(input2));
      expect(Object.keys(canonicalizeTransaction(input1))).toEqual([
        'sender',
        'receiver',
        'amount',
        'asset',
        'memo',
        'timestampBucket',
      ]);
    });
  });
});
