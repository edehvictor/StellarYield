# Vault stealth deposit announcements

This document describes how indexed stealth deposit announcements are bound to a unique asset transfer and the token context they carry.

## Overview

Stealth deposits emit an announcement that indexers use to attribute an incoming transfer to a recipient. An announcement is only valid when it is bound to exactly one asset transfer and carries the token context of that transfer.

Each announcement includes:
- A transfer identity that uniquely describes the asset transfer being announced.
- Token context (token address and chain/identifier where applicable) so that indexers can resolve the asset without ambiguity.
- The recipient and amount metadata needed to credit the deposit.

## Binding rules

1. One announcement per transfer. A transfer identity may be consumed by at most one successful announcement.
2. Repeated announcements for the same transfer identity and token context are rejected.
3. Distinct transfers that share the same value (amount, recipient, token) must produce distinct transfer identities and may each be announced once.
4. Announcements that are not backed by a corresponding asset transfer are rejected.

## Boundary behavior

- The transfer identity is treated as a opaque, comparative key. Two identities are equal only if they are byte-for-byte equal.
- Token context is part of the binding key: the same transfer identity under a different token context is a different announcement and is rejected if it does not match the backing transfer.
- An announcement with an empty or missing transfer identity is rejected.
- An announcement with an empty or missing token context is rejected.
- An announcement whose transfer identity has already been consumed is rejected.
- An announcement that cannot be matched to a backing asset transfer is rejected.

## Error results

All rejections are reported as explicit error results. Failed operations do not mutate state: no transfer identity is consumed and no announcement is recorded when an operation fails.

| Condition | Result |
| --- | --- |
| Missing or empty transfer identity | Error: invalid transfer identity |
| Missing or empty token context | Error: invalid token context |
| Repeated announcement for the same transfer identity and token context | Error: transfer already announced |
| Announcement not backed by an asset transfer | Error: unbacked announcement |
| Token context does not match the backing transfer | Error: token context mismatch |

On any error, callers must observe that the previous state is preserved and the operation can be retried with corrected inputs.

## Testing

Regression tests cover the following cases:
- Repeated announcements for the same transfer identity and token context are rejected and do not consume the identity a second time.
- Distinct transfers with the same value are announced independently with distinct transfer identities.
- Unbacked messages are rejected with the defined error result and leave state unchanged.
- Token context mismatches are rejected without consuming the transfer identity.
