# Vault share redemption preview

Before a user signs a partial withdrawal, the preview shows what it does to their position: how many shares are burned, how many assets they receive, and what is left.

The math lives in one place, [`shared/types/vaultRedemption.ts`](../shared/types/vaultRedemption.ts). The API and the client both use it, so the figures shown before signing agree with the API to the last unit.

## Rounding

Amounts are integer base units (like the on-chain `i128` values), computed with `BigInt`, so no floating-point error is involved. Rounding always favours the vault, as in ERC-4626, so a preview never promises more than a redemption can pay:

| Request | Result | Rounding |
|---|---|---|
| Redeem `N` shares | assets = `N * totalAssets / totalShares` | down |
| Withdraw exactly `A` assets | shares burned = `A * totalShares / totalAssets` | up |
| Redeem `p`% of the position | shares = `userShares * p / 100` | down (`100%` is the whole balance exactly) |
| Exit fee | fee = `gross * exitFeeBps / 10000` | down |

When you withdraw an exact number of assets, the burned shares can be worth slightly more than requested because shares are indivisible. That difference is reported as `roundingDustAssets` and stays in the vault.

## API

`POST /api/vaults/:vaultId/redemption-preview`

The caller supplies the vault state it read on-chain, in the same units as the share balance. Amounts are non-negative integers, sent as JSON numbers (safe integers only) or as decimal strings (any size up to the `i128` maximum). Every amount in the response is a decimal string.

| Field | Meaning |
|---|---|
| `totalAssets`, `totalShares` | Vault totals |
| `userShares` | The caller's whole share balance |
| exactly one of `shares`, `assets`, `percentOfPosition` | What to redeem. `percentOfPosition` is `0 < p <= 100` with at most 2 decimals |
| `exitFeeBps` | Optional exit fee, 0-10000 (default 0) |
| `minRemainingShares` | Optional. Warn when a smaller remainder would be left |

```json
{
  "vaultId": "blend-stable",
  "mode": "shares",
  "sharesToBurn": "40000000",
  "grossAssets": "42000000",
  "exitFeeBps": 0,
  "exitFeeAssets": "0",
  "netAssets": "42000000",
  "remainingShares": "60000000",
  "remainingAssets": "63000000",
  "maxRedeemableAssets": "105000000",
  "sharePrice": "1.0500000",
  "percentOfPosition": 40,
  "isFullRedemption": false,
  "roundingDustAssets": "0",
  "warnings": [],
  "quotedAt": "2025-03-01T09:00:00.000Z",
  "expiresAt": "2025-03-01T09:01:00.000Z",
  "quoteTtlMs": 60000
}
```

The quote uses the same 60-second TTL as the withdrawal preview.

### Errors

Errors use the standard `{ "error", "message", "details" }` shape with a stable `error` code:

| Status | `error` | When |
|---|---|---|
| 400 | `INVALID_VAULT_STATE` | A total or the balance is missing, negative, fractional, above the `i128` maximum, or the balance exceeds the total shares |
| 400 | `INVALID_REQUEST` | Not exactly one of `shares`, `assets`, `percentOfPosition` |
| 400 | `INVALID_AMOUNT` | `shares` or `assets` is not a positive integer |
| 400 | `INVALID_PERCENT` | `percentOfPosition` is out of range or has more than 2 decimals |
| 400 | `INVALID_FEE_BPS`, `INVALID_MIN_REMAINING` | Bad optional field |
| 400 | `INSUFFICIENT_SHARES` | The request exceeds the position. `details` holds `maxShares` and `maxAssets` |
| 400 | `REDEMPTION_TOO_SMALL` | The amount is worth less than one unit of the vault's asset |
| 409 | `VAULT_EMPTY` | The vault has no shares or no assets |

### Warnings

| Code | When |
|---|---|
| `DUST_REMAINDER` | A partial redemption leaves fewer than `minRemainingShares` shares |
| `REMAINDER_WORTHLESS` | The shares left are worth less than one unit of the asset and cannot be redeemed on their own |

## Client

The withdraw panel offers **25% / 50% / 75% / 100%** presets and shows the preview as soon as an amount is entered. It reads `totalAssets()` and `totalShares()` from the vault contract and previews locally with the shared math, so it updates instantly and needs no round trip. If the totals cannot be read, the panel says the preview is unavailable and the withdrawal itself is not blocked.
