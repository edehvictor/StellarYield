import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { createRouter } from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/errorHandler";
import type { CancelTransactionIntentUseCase } from "./services/transactionIntents/types";

export interface AppDependencies {
  readonly cancelTransactionIntent: CancelTransactionIntentUseCase;
}

/**
 * Builds the Express application with every middleware and router mounted.
 *
 * Dependencies are injected so integration tests can run the complete HTTP
 * pipeline (auth filter, validation, use case, error handler) against
 * in-memory implementations without importing the database module.
 */
export function createApp(dependencies: AppDependencies): Express {
  const app: Express = express();

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use("/api", createRouter(dependencies));

  // Terminal error handler: maps every rejection to a stable typed payload.
  app.use(errorHandler);

  return app;
}
