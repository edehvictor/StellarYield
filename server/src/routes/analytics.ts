import { Router } from "express";

type QueryPayload = {
  sql?: string;
};

const router = Router();

const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i;

function sanitizeSql(sql: string): string {
  const trimmed = sql.trim().replace(/;+$/, "");
  if (!trimmed) {
    throw new Error("SQL query is required.");
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT queries are allowed.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only one SQL statement is allowed.");
  }
  if (FORBIDDEN_SQL.test(trimmed)) {
    throw new Error("Forbidden SQL keyword detected.");
  }
  return /\blimit\s+\d+\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 500`;
}

router.post("/query", async (req, res) => {
  try {
    const body = req.body as QueryPayload;
    const sql = sanitizeSql(body.sql ?? "");

    const prismaModule = (await import("@prisma/client")) as {
      PrismaClient?: new () => {
        $queryRawUnsafe<T = unknown[]>(query: string): Promise<T>;
        $disconnect?(): Promise<void>;
      };
    };

    if (!prismaModule.PrismaClient) {
      res.status(503).json({ error: "Analytics database unavailable." });
      return;
    }

    const prisma = new prismaModule.PrismaClient();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Query timed out after 5 seconds.")), 5_000);
    });

    const rows = (await Promise.race([
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql),
      timeout,
    ])) as Record<string, unknown>[];

    await prisma.$disconnect?.();
    res.json({ rows, rowCount: rows.length });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to execute query.",
    });
  }
});

export default router;
