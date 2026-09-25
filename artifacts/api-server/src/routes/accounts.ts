import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { LinkStellarAccountBody, LinkStellarAccountResponse } from "@workspace/api-zod";
import { AccountLinkError, type AccountLinkErrorDetail } from "../lib/errors";
import {
  getValidatedStellarPublicKey,
  requireValidStellarPublicKey,
} from "../middlewares/stellarPublicKey";
import type { LinkStellarAccountUseCase } from "../services/stellarAccounts/types";

export interface AccountsRouterDependencies {
  readonly linkStellarAccount: LinkStellarAccountUseCase;
}

/**
 * Stellar account routes.
 *
 * The public key runs through the StrKey validation middleware before the
 * handler executes, and every rejection travels to the terminal error
 * handler, which answers with the stable typed `AccountLinkError` payload
 * instead of leaking stack traces or provider messages.
 */
export function createAccountsRouter(
  dependencies: AccountsRouterDependencies,
): IRouter {
  const router: IRouter = Router();

  router.post(
    "/accounts/link",
    requireValidStellarPublicKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedBody = LinkStellarAccountBody.safeParse(req.body);

        if (!parsedBody.success) {
          const details: AccountLinkErrorDetail[] =
            parsedBody.error.issues.map((issue) => ({
              path: issue.path.map(String).join(".") || "body",
              message: issue.message,
            }));
          throw AccountLinkError.invalidRequest(details);
        }

        const account = await dependencies.linkStellarAccount.execute({
          clientId: parsedBody.data.clientId,
          publicKey: getValidatedStellarPublicKey(res),
        });

        const payload = LinkStellarAccountResponse.parse({
          account: {
            id: account.id,
            clientId: account.clientId,
            publicKey: account.publicKey,
            linkedAt: account.linkedAt,
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
