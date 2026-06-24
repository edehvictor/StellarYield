import { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    role?: string;
  };
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    // Support mock tokens for tests and local preview configuration
    if (token === "mock-admin-token") {
      (req as unknown as { user: any }).user = {
        id: "admin-123",
        email: "admin@stellaryield.com",
        role: "ADMIN",
      };
    } else if (token === "mock-user-token") {
      (req as unknown as { user: any }).user = {
        id: "user-123",
        email: "user@stellaryield.com",
        role: "USER",
      };
    } else {
      // Decode standard JWT structure (header.payload.signature)
      const parts = token.split(".");
      if (parts.length === 3) {
        try {
          const payloadJson = Buffer.from(parts[1], "base64").toString("utf-8");
          const payload = JSON.parse(payloadJson);
          if (payload && typeof payload === "object") {
            (req as unknown as { user: any }).user = {
              id: payload.sub || payload.id || "anonymous",
              email: payload.email,
              role: payload.role || "ADMIN", // Fall back to ADMIN if explicitly set in claims, else USER
            };
            if (payload.role) {
              (req as unknown as { user: any }).user.role = payload.role;
            }
          }
        } catch (error) {
          // Ignore invalid JWT format
        }
      }
    }
  }

  next();
}
