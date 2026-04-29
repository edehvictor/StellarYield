# Protocol Reward Emission Schedule Registry

## Overview
The Reward Emission Schedule Registry is a centralized service for storing and managing normalized reward schedule metadata for different protocols on the Stellar network. It allows the platform to accurately reason about future APY changes by accounting for start dates, end dates, cliffs, and tapering events.

## Data Schema

### RewardSchedule
- `protocolName` (string): The unique identifier of the protocol (e.g., "Blend", "Soroswap").
- `tokenSymbol` (string): The symbol of the reward token (e.g., "BLND", "SORO").
- `dailyEmission` (number): The amount of tokens emitted per day at the start of the schedule.
- `startDate` (Date): When the emission begins.
- `endDate` (Date): When the emission schedule officially ends.
- `cliffDate` (Date, optional): If set, no rewards are emitted until this date is reached.
- `taperStartDate` (Date, optional): When the emission begins to reduce linearly.
- `taperEndDate` (Date, optional): When the tapering reaches zero (defaults to `endDate`).
- `sourceProvenance` (string): A mandatory field describing the origin of the schedule data (e.g., "Governance Proposal #42", "Official Documentation").
- `confidence` (enum): `low`, `medium`, or `high`. Used to guard against treating speculative rewards as guaranteed yield.
- `isActive` (boolean): Whether the schedule is currently considered for yield calculations.

### RewardEvent
Tracks specific lifecycle events of a schedule:
- `START`
- `END`
- `CLIFF`
- `TAPER_START`
- `TAPER_END`

## Security Considerations
- **Confidence Guard**: Yield calculations that are used for "high-confidence" recommendations should only include schedules marked as `high` or `medium` confidence.
- **Expiry Logic**: Schedules are automatically marked as inactive once their `endDate` has passed.

## Integration points
- `YieldService`: Automatically fetches active schedules and includes them in protocol yield snapshots.
- `GovernanceForecastService`: Allows forecasting the impact of reward changes on future APYs.

## Testing
Comprehensive tests for parsing logic, cliff handling, and tapering calculations can be found in `server/src/services/__tests__/rewardScheduleRegistry.test.ts`.
Minimum 90% test coverage is required for all registry-related logic.
