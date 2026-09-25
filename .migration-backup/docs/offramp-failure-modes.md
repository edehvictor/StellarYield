# Off-Ramp Provider Failure Modes

## Overview

Off-ramp flows depend on external providers (MoonPay, Stellar Anchor) to convert USDC to fiat currency. This document outlines common failure modes, their causes, and recommended remediation steps for users.

## Common Failure Modes

### 1. Unsupported Region

**Cause:** User's bank account country or region is not supported by the provider.

**Error Message:** "Your region is not supported for this transaction"

**User-Facing Remediation:**

- Check the provider's supported countries list
- Use a bank account in a supported region
- Contact support for region-specific alternatives
- Consider using a different off-ramp provider

**Technical Details:**

- MoonPay supports 150+ countries but excludes some regions
- Stellar Anchor support varies by anchor implementation
- Region validation happens at provider API level

**Related Code:** `client/src/features/offramp/offRampService.ts` - `submitToProvider()`

---

### 2. Invalid Bank Account

**Cause:** Bank account number format is invalid or doesn't match the expected format for the region.

**Error Message:** "Invalid bank account number"

**User-Facing Remediation:**

- Verify bank account number format (8+ digits for most regions)
- Check for leading zeros or special characters
- Confirm account is active and in good standing
- Contact your bank to verify account details
- Try a different account if available

**Technical Details:**

- Validation: Account must be 8+ characters
- Format varies by country (IBAN, routing number, etc.)
- Memo field limited to 28 characters for Stellar

**Related Code:** `client/src/features/offramp/offRampService.ts` - `validateDestination()`

---

### 3. Invalid Memo

**Cause:** Memo format is invalid or exceeds Stellar's 28-character limit.

**Error Message:** "Invalid memo format"

**User-Facing Remediation:**

- Ensure account holder name contains only alphanumeric characters
- Remove special characters from name
- Use a shorter name if needed
- Contact support if memo generation fails

**Technical Details:**

- Memo format: `SY:{accountHolder}:{timestamp}` (max 28 chars)
- Special characters are stripped automatically
- Timestamp uses last 6 digits for compactness

**Related Code:** `client/src/features/offramp/offRampService.ts` - `generateMemo()`

---

### 4. Provider Downtime

**Cause:** Off-ramp provider API is temporarily unavailable or experiencing issues.

**Error Message:** "Provider error: Service Unavailable" or "Connection timeout"

**User-Facing Remediation:**

- Wait 5-10 minutes and retry
- Check provider status page for known issues
- Try again during off-peak hours
- Contact support if issue persists
- Use alternative provider if available

**Technical Details:**

- Timeout: 10 seconds (configurable via `SOROBAN_RPC_TIMEOUT_MS`)
- Retry logic: Exponential backoff recommended
- Status polling: Check transaction status every 30 seconds

**Related Code:** `client/src/features/offramp/offRampService.ts` - `pollStatus()`

---

### 5. Pending Bank Transfer

**Cause:** Transaction is initiated but bank transfer is still processing.

**Status:** "pending"

**User-Facing Remediation:**

- Check transaction status in dashboard
- Bank transfers typically take 1-3 business days
- Verify bank account received funds
- Contact bank if transfer doesn't arrive within 3 days
- Provide transaction ID to support if needed

**Technical Details:**

- Status mapping: `processing` → `pending`
- Polling interval: 30 seconds (configurable)
- Max wait time: 3 business days before escalation

**Related Code:** `client/src/features/offramp/offRampService.ts` - `mapProviderStatus()`

---

### 6. Insufficient Liquidity

**Cause:** Provider doesn't have enough liquidity to process the withdrawal amount.

**Error Message:** "Insufficient liquidity for this amount"

**User-Facing Remediation:**

- Reduce withdrawal amount
- Try again later when liquidity is available
- Split into multiple smaller transactions
- Contact support for large amounts
- Use alternative provider

**Technical Details:**

- Amount limits vary by provider and region
- Typical limits: $100 - $50,000 per transaction
- Daily/monthly limits may apply

**Related Code:** `client/src/features/offramp/offRampService.ts` - `submitToProvider()`

---

### 7. Authentication Failure

**Cause:** API key or credentials are invalid, expired, or revoked.

**Error Message:** "Unauthorized: Invalid credentials"

**User-Facing Remediation:**

- This is a backend issue, not user-facing
- Contact support to verify provider credentials
- Check API key expiration
- Regenerate credentials if needed

**Technical Details:**

- Auth header: `Authorization: Bearer {apiKey}`
- Credentials stored in environment variables
- Should never be exposed to frontend

**Related Code:** `client/src/features/offramp/offRampService.ts` - `submitToProvider()`

---

### 8. Transaction Already Exists

**Cause:** Duplicate transaction ID or account already has pending transaction.

**Error Message:** "Transaction already exists"

**User-Facing Remediation:**

- Check transaction history for existing transaction
- Wait for pending transaction to complete
- Use different bank account if available
- Contact support if duplicate appears

**Technical Details:**

- Transaction ID: `offramp_{timestamp}_{random}`
- Stored in localStorage for client-side tracking
- Provider may have additional duplicate detection

**Related Code:** `client/src/features/offramp/offRampService.ts` - `initiateWithdrawal()`

---

## Error Handling Best Practices

### For Users

1. **Read Error Messages** - They provide specific guidance
2. **Check Status** - Use transaction history to track status
3. **Verify Details** - Ensure bank account and memo are correct
4. **Wait Appropriately** - Don't retry immediately for pending transfers
5. **Contact Support** - Provide transaction ID when reporting issues

### For Developers

1. **Validate Early** - Check bank account format before submission
2. **Handle Timeouts** - Implement exponential backoff for retries
3. **Track Status** - Poll provider for transaction updates
4. **Log Errors** - Include transaction ID and error details
5. **Provide Context** - Show user-friendly error messages

## Retry Strategy

```typescript
// Recommended retry logic
const maxRetries = 3;
const baseDelay = 1000; // 1 second

for (let attempt = 0; attempt < maxRetries; attempt++) {
  try {
    return await submitToProvider(transaction, request);
  } catch (error) {
    if (attempt < maxRetries - 1) {
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } else {
      throw error;
    }
  }
}
```

## Status Polling

```typescript
// Poll for transaction status
const pollInterval = 30000; // 30 seconds
const maxWaitTime = 3 * 24 * 60 * 60 * 1000; // 3 days

const startTime = Date.now();
while (Date.now() - startTime < maxWaitTime) {
  const tx = await pollStatus(txId);

  if (tx.status === "completed") {
    return tx;
  } else if (tx.status === "failed") {
    throw new Error(tx.errorMessage);
  }

  await new Promise((resolve) => setTimeout(resolve, pollInterval));
}
```

## Provider-Specific Notes

### MoonPay

- Supports 150+ countries
- Limits: $100 - $50,000 per transaction
- Processing time: 1-3 business days
- Requires KYC for amounts > $1,000
- Status page: https://status.moonpay.com

### Stellar Anchor

- Varies by anchor implementation
- Limits depend on anchor configuration
- Processing time: 1-5 business days
- May require additional verification
- Check anchor documentation for details

## Related Files

- Service: `client/src/features/offramp/offRampService.ts`
- Types: `client/src/features/offramp/types.ts`
- Component: `client/src/features/offramp/OffRampPanel.tsx`
- Tests: `client/src/features/offramp/OffRampPanel.test.ts`

## Support Resources

- **Dashboard:** Check transaction history and status
- **Help Center:** https://app.yieldaggregator.com/help
- **Contact Support:** support@yieldaggregator.com
- **Status Page:** https://status.yieldaggregator.com
