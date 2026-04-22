# Liquid Staking (yXLM)

A Soroban contract that accepts native XLM deposits, delegates to whitelisted validators, and issues a liquid staking derivative token `yXLM` that represents a pro‑rata claim on the pooled XLM and rewards.

## Features

- Native XLM deposits via the provided token contract address
- yXLM share token (ERC20‑like) with `name`, `symbol`, `decimals`, `balance`, `transfer`, `approve`, `transfer_from`
- Share accounting: `total_staked` and `total_shares` maintain exchange rate
- Rebase support: admin can scale `total_staked` to distribute validator rewards to all holders
- Backing verification: `backing_ok()` confirms `total_staked` matches on-chain balance; `sync(admin)` updates it
- Validator whitelist with per‑validator weights and delegation events

## Public Methods

- `init(admin, xlm_token)` – one‑time initializer, sets admin and native token contract address
- `upsert_validator(admin, id, weight_bps)` – add/update validator in whitelist
- `remove_validator(admin, id)` – remove validator from whitelist
- `deposit(from, amount)` – pull XLM from `from` into contract and mint yXLM shares
- `redeem(to, share_amount)` – burn shares and transfer XLM to `to`
- `rebase(admin, new_multiplier_bps)` – scale `total_staked` to reflect rewards
- `sync(admin)` – set `total_staked` to actual token balance for 1:1 backing
- `backing_ok()` – returns true if `total_staked` equals token balance
- `delegate(admin, validator_id, amount)` – emit delegation event (wire to staking layer as needed)
- Token methods: `name`, `symbol`, `decimals`, `total_supply`, `balance`, `allowance`, `approve`, `transfer`, `transfer_from`

## Notes

- The contract expects the native XLM token contract address to be passed to `init`. On mainnet/testnet this should be the official Stellar Asset Contract for XLM.
- Delegation currently emits events and enforces whitelist; integrate with a staking proxy/precompile as it becomes available.

## Testing

Run contract tests from the `contracts` workspace root:

```bash
cargo test -p liquid_staking
```

