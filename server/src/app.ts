import cors from "cors";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { createYoga } from "graphql-yoga";
import { predictApy, HistoricalDataPoint } from "./analytics/apyPredictor";
import { signFeeBump } from "./relayer/relayer";
import { context } from "./graphql/context";
import { graphqlSchema } from "./graphql/schema";
import { metricsMiddleware, getMetrics } from "./middleware/metrics";
import { auditMiddleware } from "./middleware/audit";
import { authMiddleware } from "./middleware/auth";
import { sendError } from "./utils/errorResponse";
import { requestContextMiddleware } from "./middleware/requestContext";
import { correlationIdMiddleware } from "./middleware/correlationId";
import { errorHandler, requestLoggerMiddleware } from "./middleware/requestLogger";
import yieldsRouter from "./routes/yields";
import leaderboardRouter from "./routes/leaderboard";
import notificationsRouter from "./routes/notifications";
import healthRouter from "./routes/health";
import onrampRouter from "./routes/onramp";
import zapRouter from "./routes/zap";
import depositsRouter from "./routes/deposits";
import pnlRouter from "./routes/pnl";
import exportRouter from "./routes/export";
import feesRouter from "./routes/fees";
import transparencyRouter from "./routes/transparency";
import donationsRouter from "./routes/donations";
import referralsRouter from "./routes/referrals";
import adminRouter from "./routes/admin";
import auditMonitoringRouter from "./routes/auditMonitoring";
import weeklyReportsRouter from "./routes/weeklyReports";
import prometheusMetricsRouter from "./routes/prometheusMetrics";
import alertsRouter from "./routes/alerts";
import openapiRouter from "./routes/openapi";
import incidentsRouter from "./routes/incidents";
import simulatorRouter from "./routes/simulator";
import correlationRouter from "./routes/correlation";
import strategiesRouter from "./routes/strategies";
import treasuryRouter from "./routes/treasury";
import governanceRouter from "./routes/governance";
import activityTimelineRouter from "./routes/activityTimeline";
import presetsRouter from "./routes/presets";
import analyticsRouter from "./routes/analytics";
import offrampRouter from "./routes/offramp";
import contactsRouter from "./routes/contacts";
import rebalancesRouter from "./routes/rebalances";
import sharePriceHistoryRouter from "./routes/sharePriceHistory";
import reliabilityRouter from "./routes/reliability";
import relayerStatusRouter from "./routes/relayerStatus";
import riskRouter from "./routes/risk";
import googleSheetsRouter from "./routes/googleSheets";

import { createAuthChallenge, verifyAuthChallenge } from "./utils/stellarAuth";
import {
  getRecommendationTimeline,
  recordRecommendation,
} from "./services/recommendationTimelineService";
import {
  generateDepositRecommendations,
  type DepositWizardInput,
  type UserRiskProfile,
} from "./services/depositRecommendationService";
import { runStressScenario, StressScenarioType } from "./services/stressScenarioService";

type EventsPrismaClient = {
  event: {
    findMany(args: {
      orderBy: { createdAt: "desc" };
      take: number;
    }): Promise<unknown>;
  };
  $disconnect?: () => Promise<void>;
};

async function loadPrismaClient(): Promise<EventsPrismaClient | null> {
  try {
    const prismaModule = (await import("@prisma/client")) as unknown as {
      PrismaClient?: new () => EventsPrismaClient;
    };

    if (!prismaModule.PrismaClient) {
      return null;
    }

    return new prismaModule.PrismaClient();
  } catch (error) {
    console.warn("Prisma client is unavailable for /api/events", error);
    return null;
  }
}

export function createApp() {
  const app = express();
  const yoga = createYoga({
    schema: graphqlSchema,
    context: () => context,
    graphqlEndpoint: "/api/graphql",
    graphiql: true,
  });

  app.use(cors());
  app.use(express.json());
  app.use(requestContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(metricsMiddleware);
  app.use(auditMiddleware);
  app.use(authMiddleware);
  app.use(yoga.graphqlEndpoint, yoga);

  const relayerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: "Too many requests, please try again later.",
  });

  app.post("/api/relayer/fee-bump", relayerLimiter, signFeeBump);
  app.post("/relay/sign-fee-bump", relayerLimiter, signFeeBump);
  app.use("/api/yields", yieldsRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/fees", feesRouter);
  app.use("/api/transparency", transparencyRouter);
  app.use("/api/donations", donationsRouter);
  app.use("/api/referrals", referralsRouter);
  app.use("/api/onramp", onrampRouter);
  app.use("/api/zap", zapRouter);
  app.use("/api/deposits", depositsRouter);
  app.use("/api/users", pnlRouter);
  app.use("/api/users", exportRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/audit-monitoring", auditMonitoringRouter);
  app.use("/api/weekly-reports", weeklyReportsRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/incidents", incidentsRouter);
  app.use("/api/simulator", simulatorRouter);
  app.use("/api/correlation", correlationRouter);
  app.use("/api/openapi", openapiRouter);
  app.use("/api/strategies", strategiesRouter);
  app.use("/api/treasury", treasuryRouter);
  app.use("/api/governance", governanceRouter);
  app.use("/api/portfolio/activity", activityTimelineRouter);
  app.use("/api/presets", presetsRouter);
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/offramp", offrampRouter);
  app.use("/api/contacts", contactsRouter);
  app.use("/api/rebalances", rebalancesRouter);
  app.use("/api/vaults", sharePriceHistoryRouter);
  app.use("/api/reliability", reliabilityRouter);
  app.use("/api/relayer", relayerStatusRouter);
  app.use("/api/risk", riskRouter);
  app.use("/api", googleSheetsRouter);

  // Legacy JSON metrics (internal tooling)
  app.get("/api/metrics", getMetrics);
  // Prometheus scrape endpoint
  app.use("/metrics", prometheusMetricsRouter);

  app.get("/api/events", async (req: Request, res: Response) => {
    void req;
    const prisma = await loadPrismaClient();

    if (!prisma) {
      sendError(
        res,
        503,
        "DB_UNAVAILABLE",
        "Events database is unavailable until Prisma client is generated."
      );
      return;
    }

    const events = await prisma.event.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    await prisma.$disconnect?.();
    res.json(events);
  });

  app.post("/api/recommend", (req: Request, res: Response) => {
    const {
      riskTolerance,
      timeHorizon,
      liquidityNeeds,
      userId: bodyUserId,
    } = req.body as {
      riskTolerance?: UserRiskProfile;
      timeHorizon?: DepositWizardInput["timeHorizon"];
      liquidityNeeds?: DepositWizardInput["liquidityNeeds"];
      userId?: string;
    };

    const validProfiles: UserRiskProfile[] = ["conservative", "balanced", "aggressive"];
    const profile = validProfiles.includes(riskTolerance as UserRiskProfile)
      ? (riskTolerance as UserRiskProfile)
      : "balanced";

    const input: DepositWizardInput = {
      riskTolerance: profile,
      timeHorizon:
        timeHorizon === "short" || timeHorizon === "long" ? timeHorizon : "medium",
      liquidityNeeds:
        liquidityNeeds === "high" || liquidityNeeds === "low" ? liquidityNeeds : "medium",
    };

    const result = generateDepositRecommendations(input);
    const top = result.recommendations[0];

    const recommendation = top
      ? `Based on your ${profile} risk tolerance, we recommend ${top.name} (rank #${top.rank}) with ${top.riskAdjustedYield.toFixed(2)}% risk-adjusted yield.`
      : "No vault recommendations available for your profile.";

    const userId = String(bodyUserId || "anonymous");
    const timelineEntry = recordRecommendation(userId, {
      recommendation,
      targetVault: top?.name ?? "None",
      rationale: top?.explanation ?? result.summary,
      inputSnapshot: {
        riskTolerance: profile,
        timeHorizon: input.timeHorizon,
        liquidityNeeds: input.liquidityNeeds,
        expectedApy: top?.apy ?? 0,
        liquidityDepthUsd: top?.tvlUsd ?? 0,
        volatilityPct: top?.ilVolatilityPct ?? 0,
      },
    });

    res.json({
      ...result,
      recommendation,
      targetVault: top?.name ?? null,
      expectedApy: top?.apy ?? null,
      rationale: top?.explanation ?? result.summary,
      timelineEntry,
    });
  });

  app.get("/api/recommend/timeline", (req: Request, res: Response) => {
    const userId = String(req.query.userId || "anonymous");
    res.json({
      userId,
      timeline: getRecommendationTimeline(userId),
    });
  });

  app.post("/api/stress-scenarios/run", (req: Request, res: Response) => {
    const scenario = String(req.body.scenario || "") as StressScenarioType;
    const allowedScenarios: StressScenarioType[] = [
      "apy-collapse",
      "liquidity-drain",
      "oracle-shock",
    ];
    if (!allowedScenarios.includes(scenario)) {
      res.status(400).json({
        error: "Scenario must be one of: apy-collapse, liquidity-drain, oracle-shock.",
      });
      return;
    }

    const result = runStressScenario({
      scenario,
      initialValueUsd: Number(req.body.initialValueUsd ?? 10_000),
      baseApyPct: Number(req.body.baseApyPct ?? 8),
      days: Number(req.body.days ?? 90),
    });
    res.json(result);
  });

  app.get("/api/yields/predict", (req: Request, res: Response) => {
    const protocol = (req.query.protocol as string) || "Blend";

    const mockYields = [
      { protocol: "Blend", apy: 6.5, tvl: 12000000 },
      { protocol: "Soroswap", apy: 12.2, tvl: 4500000 },
      { protocol: "DeFindex", apy: 8.9, tvl: 8000000 },
    ];
    const vault = mockYields.find((item) => item.protocol === protocol);
    const baseApy = vault?.apy ?? 5;

    const historical: HistoricalDataPoint[] = [];
    const now = new Date();
    for (let index = 29; index >= 0; index -= 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - index);
      const noise = (Math.random() - 0.5) * baseApy * 0.2;
      historical.push({
        date: date.toISOString().split("T")[0],
        apy: Math.round((baseApy + noise) * 100) / 100,
        tvl: vault?.tvl,
      });
    }

    const prediction = predictApy(protocol, historical);
    res.json(prediction);
  });

  app.post("/api/auth/challenge", (req: Request, res: Response) => {
    try {
      res.json(createAuthChallenge(req.body));
    } catch (error) {
      sendError(
        res,
        400,
        "INVALID_AUTH_REQUEST",
        error instanceof Error ? error.message : "Invalid auth request."
      );
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid auth request.",
        requestId: (req as unknown as { requestId?: string }).requestId,
      });
    }
  });

  app.post("/api/auth/verify", (req: Request, res: Response) => {
    try {
      res.json(verifyAuthChallenge(req.body));
    } catch (error) {
      sendError(
        res,
        400,
        "INVALID_AUTH_VERIFICATION",
        error instanceof Error ? error.message : "Invalid auth verification request."
      );
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Invalid auth verification request.",
        requestId: (req as unknown as { requestId?: string }).requestId,
      });
    }
  });

  app.use(errorHandler);
  return app;
}
