import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { CancelTransactionIntentBody, CancelTransactionIntentResponse } from "@workspace/api-zod";
import { ApiError, type ApiErrorDetail } from "../lib/errors";
import { getClientId, requireClientId } from "../middlewares/clientAuth";
import type { CancelTransactionIntentUseCase } from "../services/transactionIntents/types";

export interface IntentsRouterDependencies {
  readonly cancelTransactionIntent: CancelTransactionIntentUseCase;
}

/**
 * Transaction intent routes.
 *
 * Every handler is wrapped so that rejections travel to the terminal error
 * handler, which answers with the stable typed `ApiError` payload instead of
 * leaking stack traces or provider messages.
 */
export function createIntentsRouter(
  dependencies: IntentsRouterDependencies,
): IRouter {
  const router: IRouter = Router();

  router.post(
    "/intents/cancel",
    requireClientId,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedBody = CancelTransactionIntentBody.safeParse(req.body);

        if (!parsedBody.success) {
          const details: ApiErrorDetail[] = parsedBody.error.issues.map(
            (issue) => ({
              path: issue.path.map(String).join(".") || "body",
              message: issue.message,
            }),
          );
          throw ApiError.invalidRequest(details);
        }

        const intent = await dependencies.cancelTransactionIntent.execute({
          intentId: parsedBody.data.intentId,
          clientId: getClientId(res),
        });

        if (intent.status !== "cancelled" || intent.cancelledAt === null) {
          throw ApiError.internal(
            new Error("Cancel use case returned an intent in an unexpected state."),
          );
        }

        const payload = CancelTransactionIntentResponse.parse({
          intent: {
            id: intent.id,
            clientId: intent.clientId,
            status: intent.status,
            cancelledAt: intent.cancelledAt,
            updatedAt: intent.updatedAt,
          },
        });

        res.status(200).json(payload);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
