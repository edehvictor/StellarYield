import {
  validateDepositAmount,
  MIN_DEPOSIT_AMOUNT_STROOPS,
  MAX_DEPOSIT_AMOUNT_STROOPS,
} from '../utils/depositAmountValidation';

describe('validateDepositAmount', () => {
  describe('below minimum', () => {
    it('rejects an amount below the minimum', () => {
      const result = validateDepositAmount((MIN_DEPOSIT_AMOUNT_STROOPS - 1n).toString());
      expect(result).not.toBeNull();
      expect(result?.code).toBe('DEPOSIT_BELOW_MINIMUM');
      expect(result?.message).toMatch(/below the minimum/i);
    });

    it('rejects a very small positive amount (e.g. 1 stroop)', () => {
      const result = validateDepositAmount('1');
      expect(result?.code).toBe('DEPOSIT_BELOW_MINIMUM');
    });

    it('rejects a zero amount as below minimum', () => {
      const result = validateDepositAmount('0');
      expect(result?.code).toBe('DEPOSIT_BELOW_MINIMUM');
    });
  });

  describe('above maximum', () => {
    it('rejects an amount above the maximum', () => {
      const result = validateDepositAmount((MAX_DEPOSIT_AMOUNT_STROOPS + 1n).toString());
      expect(result).not.toBeNull();
      expect(result?.code).toBe('DEPOSIT_ABOVE_MAXIMUM');
      expect(result?.message).toMatch(/exceeds the maximum/i);
    });

    it('rejects an extremely large amount', () => {
      const result = validateDepositAmount('999999999999999999999999999');
      expect(result?.code).toBe('DEPOSIT_ABOVE_MAXIMUM');
    });
  });

  describe('boundaries — exactly at minimum/maximum should pass', () => {
    it('accepts an amount exactly at the minimum boundary', () => {
      const result = validateDepositAmount(MIN_DEPOSIT_AMOUNT_STROOPS.toString());
      expect(result).toBeNull();
    });

    it('accepts an amount exactly at the maximum boundary', () => {
      const result = validateDepositAmount(MAX_DEPOSIT_AMOUNT_STROOPS.toString());
      expect(result).toBeNull();
    });
  });

  describe('normal valid amount', () => {
    it('accepts a typical mid-range deposit amount', () => {
      const result = validateDepositAmount('10000000'); // 1 unit of a 7-decimal token
      expect(result).toBeNull();
    });
  });

  describe('malformed input', () => {
    it('rejects a non-numeric string', () => {
      const result = validateDepositAmount('not-a-number');
      expect(result?.code).toBe('DEPOSIT_AMOUNT_INVALID');
    });

    it('rejects a negative amount string', () => {
      const result = validateDepositAmount('-5000000');
      expect(result?.code).toBe('DEPOSIT_AMOUNT_INVALID');
    });

    it('rejects a decimal amount string', () => {
      const result = validateDepositAmount('1000000.5');
      expect(result?.code).toBe('DEPOSIT_AMOUNT_INVALID');
    });

    it('rejects an empty string', () => {
      const result = validateDepositAmount('');
      expect(result?.code).toBe('DEPOSIT_AMOUNT_INVALID');
    });
  });

  describe('custom bounds', () => {
    it('respects a custom min/max override', () => {
      expect(validateDepositAmount('50', { min: 100n, max: 1000n })?.code).toBe(
        'DEPOSIT_BELOW_MINIMUM'
      );
      expect(validateDepositAmount('1500', { min: 100n, max: 1000n })?.code).toBe(
        'DEPOSIT_ABOVE_MAXIMUM'
      );
      expect(validateDepositAmount('500', { min: 100n, max: 1000n })).toBeNull();
    });
  });
});
