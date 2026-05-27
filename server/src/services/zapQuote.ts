import * as StellarSdk from "@stellar/stellar-sdk";
import { slippageRegistry } from "./slippageRegistry";
import { getYieldData } from "./yieldService";
import { freezeService } from "./freezeService";

export interface ZapQuoteBody {
  inputTokenContract: string;
  vaultTokenContract: string;
  amountInStroops: string;
  inputDecimals: number;
  vaultDecimals: number;
  slippageTolerance?: number;
  protocol?: string;
}

export interface ZapQuoteResult {
  path: { contractId: string; label?: string }[];
  expectedAmountOutStroops: string;
  source: "router_simulation" | "fallback_rate";
  slippageApplied: number;
  amountOutAfterSlippage: string;
  quotedAt: string;
  minAmountOutStroops: string;
  quoteAgeMs: number;
  isFallback: boolean;
}

const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

function mulDivStroops(amountIn: string, numerator: string, denominator: string): string {
  const a = BigInt(amountIn);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === BigInt(0)) {
    return "0";
  }
  return ((a * n) / d).toString();
}

export async function quoteViaRouterSimulation(
  body: ZapQuoteBody,
): Promise<ZapQuoteResult | null> {
  const routerId = process.env.DEX_ROUTER_CONTRACT_ID;
  const simSource = process.env.ZAP_QUOTE_SIM_SOURCE_ACCOUNT;
  if (!routerId || !simSource) {
    return null;
  }

  try {
    const server = new StellarSdk.rpc.Server(rpcUrl);
    const router = new StellarSdk.Contract(routerId);
    const amountIn = BigInt(body.amountInStroops);
    const minOut = BigInt(0);

    const op = router.call(
      "swap",
      new StellarSdk.Address(body.inputTokenContract).toScVal(),
      new StellarSdk.Address(body.vaultTokenContract).toScVal(),
      StellarSdk.nativeToScVal(amountIn, { type: "i128" }),
      StellarSdk.nativeToScVal(minOut, { type: "i128" }),
    );

    const source = await server.getAccount(simSource);
    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const timeoutMs = parseInt(process.env.SOROBAN_RPC_TIMEOUT_MS ?? "10000", 10);
    const simulated = await Promise.race([
      server.simulateTransaction(tx),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), timeoutMs)
      ),
    ]);

    if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
      return null;
    }

    const success = simulated as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse;
    const retval = success.result?.retval;
    if (!retval) {
      return null;
    }

    const out = StellarSdk.scValToNative(retval) as bigint | number | string;
    const expected =
      typeof out === "bigint" ? out : BigInt(String(out));

    const now = Date.now();

    return {
      path: [
        { contractId: body.inputTokenContract, label: "in" },
        { contractId: body.vaultTokenContract, label: "out" },
      ],
      expectedAmountOutStroops: expected.toString(),
      source: "router_simulation",
      slippageApplied: 0,
      amountOutAfterSlippage: expected.toString(),
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: expected.toString(),
      quoteAgeMs: 0,
      isFallback: false,
    };
  } catch {
    return null;
  }
}

export function quoteFallback(body: ZapQuoteBody): ZapQuoteResult {
  const amountIn = body.amountInStroops;
  const now = Date.now();

  if (body.inputTokenContract === body.vaultTokenContract) {
    return {
      path: [{ contractId: body.inputTokenContract }],
      expectedAmountOutStroops: amountIn,
      source: "fallback_rate",
      slippageApplied: 0,
      amountOutAfterSlippage: amountIn,
      quotedAt: new Date(now).toISOString(),
      minAmountOutStroops: amountIn,
      quoteAgeMs: 0,
      isFallback: true,
    };
  }

  const num = process.env.ZAP_FALLBACK_NUMERATOR ?? "1";
  const den = process.env.ZAP_FALLBACK_DENOMINATOR ?? "1";
  const expected = mulDivStroops(amountIn, num, den);

  return {
    path: [
      { contractId: body.inputTokenContract, label: "in" },
      { contractId: body.vaultTokenContract, label: "out" },
    ],
    expectedAmountOutStroops: expected,
    source: "fallback_rate",
    slippageApplied: 0,
    amountOutAfterSlippage: expected,
    quotedAt: new Date(now).toISOString(),
    minAmountOutStroops: expected,
    quoteAgeMs: 0,
    isFallback: true,
  };
}

export async function getZapQuote(body: ZapQuoteBody): Promise<ZapQuoteResult> {
  if (freezeService.isFrozen(body.protocol)) {
    throw new Error(`Quoting is temporarily disabled for ${body.protocol || "all protocols"} due to safety freeze.`);
  }

  const quotedAt = new Date().toISOString();

  const sim = (await quoteViaRouterSimulation(body)) || quoteFallback(body);

  const protocol = body.protocol || "default";
  const model = slippageRegistry.getModel(protocol);

  const yieldData = await getYieldData();
  const protocolData = yieldData.find(y => y.protocolName.toLowerCase() === protocol.toLowerCase());
  const tvl = BigInt(Math.floor(protocolData?.tvl || 10_000_000));

  const amountIn = BigInt(body.amountInStroops);
  const slippage = model.calculateSlippage(amountIn, tvl);

  const userSlippage = body.slippageTolerance !== undefined
    ? Math.min(Math.max(body.slippageTolerance, 0.001), 0.15)
    : slippage;

  const effectiveSlippage = Math.max(slippage, userSlippage);

  const expectedOut = BigInt(sim.expectedAmountOutStroops);
  const multiplier = 1 - effectiveSlippage;
  const outAfterSlippage = (expectedOut * BigInt(Math.floor(multiplier * 10000))) / BigInt(10000);

  const now = Date.now();
  const quotedAtMs = new Date(quotedAt).getTime();

  return {
    ...sim,
    slippageApplied: effectiveSlippage,
    amountOutAfterSlippage: outAfterSlippage.toString(),
    minAmountOutStroops: outAfterSlippage.toString(),
    quotedAt,
    quoteAgeMs: now - quotedAtMs,
    isFallback: sim.source === "fallback_rate",
  };
}
