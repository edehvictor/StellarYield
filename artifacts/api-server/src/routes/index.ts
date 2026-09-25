import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { createAccountsRouter, type AccountsRouterDependencies } from "./accounts";

export type RouterDependencies = AccountsRouterDependencies;

/**
 * Builds the `/api` router with every feature router mounted. Dependencies
 * are injected so tests can exercise the full HTTP stack against in-memory
 * implementations without touching the database.
 */
export function createRouter(dependencies: RouterDependencies): IRouter {
  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(createAccountsRouter(dependencies));

  return router;
}
