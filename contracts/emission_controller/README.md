# Emission Controller (PID)

PID-based algorithmic gauge that dynamically adjusts daily token emissions to reach a target TVL utilization ratio.

## Model

- Input: `utilization_bps` (0..=10_000), target `target_utilization_bps` (0..=10_000)
- Error: `e = target - measured` (scaled to 1e7 for precision)
- PID: `delta = Kp*e + Ki*∫e dt + Kd*de/dt` where `Kp,Ki,Kd` are basis points
- Emission: `emission_next = clamp(emission_prev + delta_scaled, [min_emission, max_emission])`
- Anti-windup: decay integral slightly when clamping occurs

## Public API

- `init(admin, target_bps, kp_bps, ki_bps, kd_bps, min_emission, max_emission)`
- `configure(admin, target_bps, kp_bps, ki_bps, kd_bps)`
- `set_bounds(admin, min_emission, max_emission)`
- `compute_emission(utilization_bps) -> emission`
- `params() -> (target_bps, kp_bps, ki_bps, kd_bps, min, max)`
- `state() -> (integral_accum, last_error, last_emission)`

## Tests

Run:

```bash
cargo test -p emission_controller
```

