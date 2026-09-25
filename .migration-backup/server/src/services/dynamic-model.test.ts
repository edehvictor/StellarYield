import { describe, it, expect } from 'vitest';
import { BigNumber } from 'bignumber.js';
import { pricingService, PriceImpactTooHighError } from '../../src/pricing/dynamic-model';

describe('PricingService: calculateImpactPrice', () => {
  const liquidityX = new BigNumber(1000000); // 1M pool
  const liquidityY = new BigNumber(1000000); // 1M pool
  const feeBps = 30; // 0.3%

  it('should calculate accurate results for a standard small trade', () => {
    const baseAmount = new BigNumber(1000); // 0.1% of pool
    const result = pricingService.calculateImpactPrice(baseAmount, liquidityX, liquidityY, feeBps);

    // Expected Fee: 1000 * 0.003 = 3
    expect(result.feeIncurred.toString()).toBe('3');
    
    // Expected Impact: Very low for 0.1% trade
    expect(result.priceImpact).toBeGreaterThan(0);
    expect(result.priceImpact).toBeLessThan(1);
    
    expect(result.executionPrice.isLessThan(1)).toBe(true);
  });

  it('should trigger the 15% circuit breaker for whale trades', () => {
    // Large trade relative to pool liquidity
    const whaleAmount = new BigNumber(200000); 

    expect(() => {
      pricingService.calculateImpactPrice(whaleAmount, liquidityX, liquidityY, feeBps);
    }).toThrow(PriceImpactTooHighError);

    try {
      pricingService.calculateImpactPrice(whaleAmount, liquidityX, liquidityY, feeBps);
    } catch (e) {
      if (e instanceof PriceImpactTooHighError) {
        expect(e.impact).toBeGreaterThan(15);
      }
    }
  });

  it('should apply fees correctly to the effective input', () => {
    const amount = new BigNumber(10000);
    const highFee = 500; // 5%
    
    const result = pricingService.calculateImpactPrice(amount, liquidityX, liquidityY, highFee);
    
    // 10000 * 0.05 = 500
    expect(result.feeIncurred.toNumber()).toBe(500);
  });
});