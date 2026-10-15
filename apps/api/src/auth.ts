import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { UserRole } from "@fitzone/shared";
import { User } from "./models";

export interface AuthenticatedRequest extends Request {
  auth?: { userId: string; role: UserRole };
  locationId?: string;
}

declare global {
  namespace Express {
    interface Request {
      locationId?: string;
    }
  }
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required");
  if (secret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  return secret;
}

export function signToken(user: { id: string; role: UserRole; authVersion: number }): string {
  return jwt.sign({ sub: user.id, role: user.role, ver: user.authVersion }, getSecret(), {
    expiresIn: "8h", issuer: "fitzone-api", audience: "fitzone-web", algorithm: "HS256",
  });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.fitzone_session as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, getSecret(), { algorithms: ["HS256"], issuer: "fitzone-api", audience: "fitzone-web" });
    if (typeof verified === "string" || typeof verified.sub !== "string" || !Number.isInteger(verified.ver)
      || !["owner", "staff", "trainer", "member"].includes(String(verified.role))) {
      res.status(401).json({ error: "Invalid session" });
      return;
    }
    payload = verified;
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }
  void User.findById(payload.sub).select("role +authVersion").lean().then((result) => {
    const account = result as unknown as { _id: unknown; role: string; authVersion?: number } | null;
    if (!account || (account.authVersion ?? 0) !== payload.ver || account.role !== payload.role) {
      res.status(401).json({ error: "Session expired. Please sign in again." });
      return;
    }
    req.auth = { userId: String(account._id), role: account.role as UserRole };
    next();
  }).catch(next);
}

export function allowRoles(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: "You do not have permission to perform this action" });
      return;
    }
    next();
  };
}
