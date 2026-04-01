import cors from "cors";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { createYoga } from "graphql-yoga";
import { predictApy, HistoricalDataPoint } from "./analytics/apyPredictor";
import { signFeeBump } from "./relayer/relayer";
import { context } from "./graphql/context";
import { graphqlSchema } from "./graphql/schema";
import yieldsRouter from "./routes/yields";
import leaderboardRouter from "./routes/leaderboard";
import notificationsRouter from "./routes/notifications";
import healthRouter from "./routes/health";
import onrampRouter from "./routes/onramp";
import zapRouter from "./routes/zap";
import pnlRouter from "./routes/pnl";
import exportRouter from "./routes/export";
import feesRouter from "./routes/fees";
import {
  createAuthChallenge,
  verifyAuthChallenge,
} from "./utils/stellarAuth";

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
    const prismaModule = (await import("@prisma/client")) as {
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
  app.use(yoga.graphqlEndpoint, yoga);

  const relayerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: "Too many requests, please try again later.",
  });

  app.post("/api/relayer/fee-bump", relayerLimiter, signFeeBump);
  app.use("/api/yields", yieldsRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/health", healthRouter);
  app.use("/api/fees", feesRouter);
  app.use("/api/onramp", onrampRouter);
  app.use("/api/zap", zapRouter);
  app.use("/api/users", pnlRouter);
  app.use("/api/users", exportRouter);

  app.get("/api/events", async (req: Request, res: Response) => {
    void req;
    const prisma = await loadPrismaClient();

    if (!prisma) {
      res.status(503).json({
        error: "Events database is unavailable until Prisma client is generated.",
      });
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
    const { preferences, riskTolerance } = req.body;
    void preferences;
    res.json({
      recommendation: `Based on your ${riskTolerance || "moderate"} risk tolerance, we recommend the Yield Index vault on DeFindex for diversified, stable returns.`,
      targetVault: "DeFindex Yield Index",
      expectedApy: 8.9,
    });
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
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid auth request.",
      });
    }
  });

  app.post("/api/auth/verify", (req: Request, res: Response) => {
    try {
      res.json(verifyAuthChallenge(req.body));
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Invalid auth verification request.",
      });
    }
  });

  return app;
}
