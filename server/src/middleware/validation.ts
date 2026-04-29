import { Request, Response, NextFunction } from "express";
import { sendError } from "../utils/errorResponse";

export function validateWalletAddress(req: Request, res: Response, next: NextFunction): void {
  const address = req.params.address || req.params.walletAddress;
  if (!address || typeof address !== "string" || address.length < 10 || !/^[GC][A-Z2-7]{55}$/.test(address)) {
    sendError(res, 400, "INVALID_ADDRESS", "Invalid Stellar wallet address.");
    return;
  }
  next();
}

export function validatePagination(req: Request, res: Response, next: NextFunction): void {
  const page = parseInt(req.query.page as string);
  const limit = parseInt(req.query.limit as string);
  if ((page && (isNaN(page) || page < 1)) || (limit && (isNaN(limit) || limit < 1 || limit > 100))) {
    sendError(res, 400, "INVALID_PAGINATION", "Invalid page or limit parameters.");
    return;
  }
  next();
}

export function validateZapQuote(req: Request, res: Response, next: NextFunction): void {
  const { inputTokenContract, vaultTokenContract, amountInStroops } = req.body;
  if (!inputTokenContract || !vaultTokenContract || amountInStroops === undefined) {
    sendError(res, 400, "MISSING_FIELDS", "inputTokenContract, vaultTokenContract, and amountInStroops are required.");
    return;
  }
  if (typeof amountInStroops !== "string" || !/^-?\d+$/.test(amountInStroops)) {
    sendError(res, 400, "INVALID_AMOUNT", "amountInStroops must be an integer string.");
    return;
  }
  next();
}