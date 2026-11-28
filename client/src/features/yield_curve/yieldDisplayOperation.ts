import type {
  CompoundFrequency,
  Horizon,
  ProjectionAssumptions,
  YieldCurveResult,
} from "./types";
import { validateAssumptions } from "./yieldProjection";
import {
  defaultYieldDisplayOperationManager,
  resolveYieldDisplayOperationIdentity,
  type SafeYieldDisplayResult,
  type YieldCurveDisplayPayload,
  type YieldDisplayEffect,
  type YieldDisplayErrorCode,
  type YieldDisplayOperationIdentity,
  type YieldDisplayOperationManager,
} from "../../../../shared/types/yieldDataDisplayOperation";

export interface CommittedYieldDisplayState {
  result: YieldCurveResult | null;
  identity?: YieldDisplayOperationIdentity;
  effect?: YieldDisplayEffect;
  error?: string;
  errorCode?: YieldDisplayErrorCode;
  replayed: boolean;
}

export interface CommitYieldDisplayOptions {
  horizon: Horizon;
  assumptions: ProjectionAssumptions;
  currentState: CommittedYieldDisplayState;
  previousIdentity?: YieldDisplayOperationIdentity;
  manager?: YieldDisplayOperationManager;
  configVersion?: string;
  execute?: () => YieldCurveResult;
}

export interface CommitYieldDisplayOutcome {
  identity: YieldDisplayOperationIdentity;
  state: CommittedYieldDisplayState;
  outcome: SafeYieldDisplayResult<CommittedYieldDisplayState, YieldCurveResult | undefined>;
}

export function toYieldCurveDisplayPayload(
  horizon: Horizon,
  assumptions: ProjectionAssumptions,
  configVersion?: string,
): YieldCurveDisplayPayload {
  return {
    scope: "yield-curve",
    horizon,
    principalUsd: assumptions.principalUsd,
    compounding: assumptions.compounding,
    feeDragPct: assumptions.feeDragPct,
    allocations: assumptions.allocations.map((leg) => ({
      id: leg.id,
      apyPct: leg.apyPct,
      weightPct: leg.weightPct,
    })),
    configVersion,
  };
}

export function commitYieldDisplaySnapshot({
  horizon,
  assumptions,
  currentState,
  previousIdentity,
  manager = defaultYieldDisplayOperationManager,
  configVersion,
  execute,
}: CommitYieldDisplayOptions): CommitYieldDisplayOutcome {
  const payload = toYieldCurveDisplayPayload(horizon, assumptions, configVersion);
  const identity = resolveYieldDisplayOperationIdentity(payload, previousIdentity);
  const outcome = manager.executeYieldDisplaySync<
    CommittedYieldDisplayState,
    YieldCurveResult | undefined
  >({
    payload,
    operationIdentity: identity,
    currentState,
    validate: (submitted) => {
      const errors = validateAssumptions({
        principalUsd: submitted.scope === "yield-curve" ? submitted.principalUsd : 0,
        compounding: (submitted.scope === "yield-curve"
          ? submitted.compounding
          : "daily") as CompoundFrequency,
        feeDragPct: submitted.scope === "yield-curve" ? submitted.feeDragPct : 0,
        allocations:
          submitted.scope === "yield-curve"
            ? submitted.allocations.map((leg) => ({
                id: leg.id,
                label: leg.id,
                apyPct: leg.apyPct,
                weightPct: leg.weightPct,
              }))
            : [],
      });
      return errors.length ? errors.join(" ") : true;
    },
    execute,
    onSuccessStateUpdate: (state, effect, result) => ({
      result: result ?? state.result,
      identity,
      effect,
      replayed: false,
    }),
  });

  return {
    identity,
    state: outcome.success
      ? outcome.state
      : {
          ...currentState,
          identity: currentState.identity ?? identity,
          error: outcome.error,
          errorCode: outcome.errorCode,
          replayed: false,
        },
    outcome,
  };
}
