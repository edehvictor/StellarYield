import { Request, Response, NextFunction } from "express";
import { errorEnvelope } from "../types/envelope";

/**
 * Shared route-level authorization policy for sensitive endpoints
 * (admin, AI/risk config, treasury, keeper-facing routes).
 *
 * #935 — centralizes the authz check so policy can't drift between routers.
 */
export function requireRole(...allowedRoles: string[]) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const user = (req as unknown as Record<string, unknown>).user as
      | { role?: string }
      | undefined;

    const route = req.baseUrl || req.path || "authz";

    if (!user) {
      res.status(401).json(
        errorEnvelope("UNAUTHORIZED", "Unauthorized: authentication required", route),
      );
      return;
    }

    if (!user.role || !allowedRoles.includes(user.role)) {
      res.status(403).json(
        errorEnvelope("FORBIDDEN", "Unauthorized: Admin access required", route),
      );
      return;
    }

    next();
  };
}

export const requireAdmin = requireRole("ADMIN");

