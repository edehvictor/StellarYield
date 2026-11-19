# Emission Controller (PID)

PID-based algorithmic gauge that dynamically adjusts daily token emissions to reach a target TVL utilization ratio.

## Model

- Input: `utilization_bps` (0..=10_000), target `target_utilization_bps` (0..=10_000)
- Error: `e = target - measured` (scaled to 1e7 for precision)
- PID: `delta = Kp*e + Ki*∫e dt + Kd*de/dt` where `Kp,Ki,Kd` are basis points
- Emission: `emission_next = clamp(emission_prev + delta_scaled, [min_emission, max_emission])`
- Anti-windup: decay integral slightly when clamping occurs

## Public API

### PID Controller
- `init(admin, target_bps, kp_bps, ki_bps, kd_bps, min_emission, max_emission)`
- `configure(admin, target_bps, kp_bps, ki_bps, kd_bps)`
- `set_bounds(admin, min_emission, max_emission)`
- `compute_emission(utilization_bps) -> emission`
- `params() -> (target_bps, kp_bps, ki_bps, kd_bps, min, max)`
- `state() -> (integral_accum, last_error, last_emission)`

### Scheduled Epochs & Caps (#1496, #1497, #1498)
- `set_schedule(admin, lifetime_cap, epochs)` - Configure or replace scheduled epochs within lifetime emission cap
- `set_recipient_weights(admin, recipients)` - Configure recipient basis point allocations (100% = 10,000 bps)
- `mint_epoch_emission(admin, epoch_id, amount) -> AllocationSnapshot` - Mint within active epoch, bounded by epoch & lifetime caps
- `get_epoch(epoch_id) -> Epoch` - Query epoch status and minted amounts
- `get_lifetime_cap() -> i128`, `get_lifetime_minted() -> i128` - Cumulative emission cap and minted supply
- `get_allocation_snapshot(epoch_id, mint_index) -> AllocationSnapshot` - Auditable recipient weight snapshots
- `get_mint_count(epoch_id) -> u32` - Total mint operations in an epoch
- `get_recipient_weights() -> Vec<RecipientWeight>` - Current recipient allocations
- `set_token(admin, token)`, `get_token() -> Option<Address>` - Optional Stellar Asset Contract for direct minting

## Tests

Run:

```bash
cargo test -p emission_controller
```

