/**
 * Contract event fixture generator for integration tests (issue #1396).
 *
 * Produces deterministic, typed representations of every recognized vault
 * event topic so integration tests can assert on decoded payloads without
 * coupling to a live Soroban RPC node or a real transaction hash.
 *
 * Usage:
 *   import { makeDepositEvent, makeVaultEventBatch } from ".../contractEventFixtures";
 *   const evt = makeDepositEvent({ contractId: "CVAULT…", ledger: 100 });
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A minimal representation of a decoded Soroban contract event. */
export interface ContractEventFixture {
  /** Soroban contract address (56-char strkey, starts with C). */
  contractId: string;
  /** Ledger sequence the event was emitted in. */
  ledger: number;
  /** Deterministic transaction hash placeholder. */
  txHash: string;
  /** Short event topic matching events.rs recognized topics. */
  topic: string;
  /** Schema version (always 1 for current fixtures). */
  schemaVersion: number;
  /** Typed event payload. */
  data: Record<string, unknown>;
}

/** Options shared by all fixture builders. */
export interface EventFixtureOptions {
  contractId?: string;
  ledger?: number;
  txHash?: string;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_CONTRACT_ID =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

export const DEFAULT_LEDGER = 1_000_000;

const DEFAULT_DEPOSITOR = "GDEP0000000000000000000000000000000000000000000000000001";
const DEFAULT_WITHDRAWER = "GWIT0000000000000000000000000000000000000000000000000001";
const DEFAULT_KEEPER = "GKPR0000000000000000000000000000000000000000000000000001";
const DEFAULT_ADMIN = "GADM0000000000000000000000000000000000000000000000000001";

/** Build a stable tx hash from ledger + topic so fixtures are deterministic. */
function syntheticTxHash(ledger: number, topic: string): string {
  const seed = `${ledger}:${topic}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(64, "0");
}

function base(
  topic: string,
  data: Record<string, unknown>,
  opts: EventFixtureOptions = {},
): ContractEventFixture {
  const ledger = opts.ledger ?? DEFAULT_LEDGER;
  return {
    contractId: opts.contractId ?? DEFAULT_CONTRACT_ID,
    ledger,
    txHash: opts.txHash ?? syntheticTxHash(ledger, topic),
    topic,
    schemaVersion: 1,
    data,
  };
}

// ── Per-topic builders ────────────────────────────────────────────────────────

/** Vault initialized event (`init` topic). */
export function makeInitEvent(
  opts: EventFixtureOptions & { admin?: string } = {},
): ContractEventFixture {
  return base("init", { admin: opts.admin ?? DEFAULT_ADMIN, version: 1 }, opts);
}

/** Deposit event (`dep_for` topic). */
export function makeDepositEvent(
  opts: EventFixtureOptions & {
    depositor?: string;
    amountUsdc?: number;
    sharesIssued?: number;
  } = {},
): ContractEventFixture {
  return base(
    "dep_for",
    {
      depositor: opts.depositor ?? DEFAULT_DEPOSITOR,
      amount_usdc: opts.amountUsdc ?? 1_000_000,
      shares_issued: opts.sharesIssued ?? 999_990,
    },
    opts,
  );
}

/** Withdrawal event (`withdrawal` topic — legacy) and `with` topic. */
export function makeWithdrawalEvent(
  opts: EventFixtureOptions & {
    withdrawer?: string;
    sharesBurned?: number;
    amountUsdc?: number;
  } = {},
): ContractEventFixture {
  return base(
    "with",
    {
      withdrawer: opts.withdrawer ?? DEFAULT_WITHDRAWER,
      shares_burned: opts.sharesBurned ?? 500_000,
      amount_usdc: opts.amountUsdc ?? 500_250,
    },
    opts,
  );
}

/** Rebalance event (`rebal` topic). */
export function makeRebalanceEvent(
  opts: EventFixtureOptions & {
    triggerReason?: string;
    allocations?: Array<{ strategy: string; shareBps: number }>;
  } = {},
): ContractEventFixture {
  return base(
    "rebal",
    {
      trigger_reason: opts.triggerReason ?? "drift_threshold",
      allocations: opts.allocations ?? [
        { strategy: "blend-stable", share_bps: 6_000 },
        { strategy: "soroswap-lp", share_bps: 4_000 },
      ],
    },
    opts,
  );
}

/** Share transfer event (`tr_sh` topic). */
export function makeShareTransferEvent(
  opts: EventFixtureOptions & {
    from?: string;
    to?: string;
    amount?: number;
  } = {},
): ContractEventFixture {
  return base(
    "tr_sh",
    {
      from: opts.from ?? DEFAULT_DEPOSITOR,
      to: opts.to ?? DEFAULT_WITHDRAWER,
      amount: opts.amount ?? 100_000,
    },
    opts,
  );
}

/** Harvest event (`harvest` topic). */
export function makeHarvestEvent(
  opts: EventFixtureOptions & {
    yieldUsdc?: number;
    feesUsdc?: number;
    keeper?: string;
  } = {},
): ContractEventFixture {
  return base(
    "harvest",
    {
      yield_usdc: opts.yieldUsdc ?? 12_500,
      fees_usdc: opts.feesUsdc ?? 625,
      keeper: opts.keeper ?? DEFAULT_KEEPER,
    },
    opts,
  );
}

/** Admin action event (`admin_action` topic). */
export function makeAdminActionEvent(
  opts: EventFixtureOptions & {
    action?: string;
    actor?: string;
  } = {},
): ContractEventFixture {
  return base(
    "admin_action",
    {
      action: opts.action ?? "set_strategy_config",
      actor: opts.actor ?? DEFAULT_ADMIN,
    },
    opts,
  );
}

/** Pause event (`pause` topic). */
export function makePauseEvent(opts: EventFixtureOptions = {}): ContractEventFixture {
  return base("pause", { reason: "emergency_shutdown" }, opts);
}

/** Unpause event (`unpause` topic). */
export function makeUnpauseEvent(opts: EventFixtureOptions = {}): ContractEventFixture {
  return base("unpause", { resumed_by: DEFAULT_ADMIN }, opts);
}

/** Referral event (`referral` topic). */
export function makeReferralEvent(
  opts: EventFixtureOptions & {
    referrer?: string;
    referee?: string;
    rewardUsdc?: number;
  } = {},
): ContractEventFixture {
  return base(
    "referral",
    {
      referrer: opts.referrer ?? DEFAULT_ADMIN,
      referee: opts.referee ?? DEFAULT_DEPOSITOR,
      reward_usdc: opts.rewardUsdc ?? 250,
    },
    opts,
  );
}

/** Flash loan event (`flash` topic). */
export function makeFlashLoanEvent(
  opts: EventFixtureOptions & {
    borrower?: string;
    amountUsdc?: number;
    feeUsdc?: number;
  } = {},
): ContractEventFixture {
  return base(
    "flash",
    {
      borrower: opts.borrower ?? DEFAULT_DEPOSITOR,
      amount_usdc: opts.amountUsdc ?? 5_000_000,
      fee_usdc: opts.feeUsdc ?? 5_000,
    },
    opts,
  );
}

// ── Batch builder ─────────────────────────────────────────────────────────────

/**
 * Returns one fixture for every recognized vault event topic, all anchored to
 * the same `contractId` and consecutive ledgers starting at `baseLedger`.
 *
 * Useful for smoke-testing a decoder that must handle a full event stream.
 */
export function makeVaultEventBatch(
  opts: {
    contractId?: string;
    baseLedger?: number;
  } = {},
): ContractEventFixture[] {
  const contractId = opts.contractId ?? DEFAULT_CONTRACT_ID;
  const base = opts.baseLedger ?? DEFAULT_LEDGER;

  return [
    makeInitEvent({ contractId, ledger: base }),
    makeDepositEvent({ contractId, ledger: base + 1 }),
    makeWithdrawalEvent({ contractId, ledger: base + 2 }),
    makeRebalanceEvent({ contractId, ledger: base + 3 }),
    makeShareTransferEvent({ contractId, ledger: base + 4 }),
    makeHarvestEvent({ contractId, ledger: base + 5 }),
    makeAdminActionEvent({ contractId, ledger: base + 6 }),
    makePauseEvent({ contractId, ledger: base + 7 }),
    makeUnpauseEvent({ contractId, ledger: base + 8 }),
    makeReferralEvent({ contractId, ledger: base + 9 }),
    makeFlashLoanEvent({ contractId, ledger: base + 10 }),
  ];
}

// ── Unknown / future-version fixture (dead-letter path) ───────────────────────

/** An event with an unrecognized topic — exercises the dead-letter branch. */
export function makeUnknownEvent(
  opts: EventFixtureOptions & { topic?: string } = {},
): ContractEventFixture {
  return base(opts.topic ?? "future_event_v99", { payload: "opaque" }, opts);
}
