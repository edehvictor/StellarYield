import { Request, Response, NextFunction } from "express";

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

    if (!user) {
      res.status(401).json({
        error: "Unauthorized: authentication required",
      });
      return;
    }

    if (!user.role || !allowedRoles.includes(user.role)) {
      res.status(403).json({
        error: "Unauthorized: Admin access required",
      });
      return;
    }

    next();
  };
}

export const requireAdmin = requireRole("ADMIN");
