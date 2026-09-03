import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../utils/errors";
import { verifyAccessToken } from "../utils/jwt";
import { User } from "../models/User";
import "../models/Role";
import "../models/Permission";
import type { CustomReq, UserRole, VerificationLevel } from "../types/auth";

function extractAccessToken(req: Request): string | undefined {
  const cookieToken =
    (req.cookies?.access_token as string | undefined) ?? undefined;
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (!authHeader) return undefined;
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

export async function requireAuth(
  req: CustomReq,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractAccessToken(req);
    if (!token) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub).populate({
      path: "assignedRole",
      populate: { path: "permissions" }
    }).populate("customPermissions").lean();

    if (!user) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }

    if (user.status !== "active") {
      next(new ApiError(403, "FORBIDDEN", "Account suspended"));
      return;
    }

    // Verify session version (optional, if payload includes it and user has it)
    if (payload.sessionVersion !== undefined && user.sessionVersion !== undefined) {
      if (payload.sessionVersion !== user.sessionVersion) {
        next(new ApiError(401, "UNAUTHENTICATED", "Session expired or revoked"));
        return;
      }
    }

    const assignedRole = user.assignedRole as any;
    const rolePermissions = assignedRole?.permissions?.map((p: any) => p.name) || [];
    const customPermissions = (user.customPermissions as any)?.map((p: any) => p.name) || [];
    
    // Merge unique permissions
    const permissions = Array.from(new Set([...rolePermissions, ...customPermissions]));

    req.user = {
      id: String(user._id),
      email: user.email,
      role: user.role as UserRole,
      name: user.name ?? null,
      isEmailVerified: Boolean(user.isEmailVerified),
      isPhoneVerified: Boolean(user.isPhoneVerified),
      verificationLevel: (user.verificationLevel as any) || "basic",
      verificationStatus: (user.verificationStatus as any) || "unverified",
      permissions,
      sessionVersion: user.sessionVersion,
    };

    next();
  } catch (error) {
    console.error("requireAuth failed:", error);
    next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
  }
}

export function requireRole(roles: UserRole[]) {
  return (req: CustomReq, _res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }
    if (!roles.includes(role)) {
      next(new ApiError(403, "FORBIDDEN", "Insufficient permissions"));
      return;
    }
    next();
  };
}

export function requireVerificationLevel(levels: VerificationLevel[]) {
  return (req: CustomReq, _res: Response, next: NextFunction) => {
    const level = req.user?.verificationLevel;
    if (!level) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }
    if (!levels.includes(level)) {
      next(new ApiError(403, "FORBIDDEN", "Insufficient verification level"));
      return;
    }
    next();
  };
}

export function requirePermission(permissions: string | string[]) {
  return (req: CustomReq, _res: Response, next: NextFunction) => {
    if (!req.user) {
      next(new ApiError(401, "UNAUTHENTICATED", "Authentication required"));
      return;
    }
    
    const requiredPerms = Array.isArray(permissions) ? permissions : [permissions];
    const userPerms = req.user.permissions || [];
    
    // Check if user has ALL required permissions
    const hasPermission = requiredPerms.every((perm) => userPerms.includes(perm));
    
    if (!hasPermission) {
      next(new ApiError(403, "FORBIDDEN", "Insufficient permissions"));
      return;
    }
    
    next();
  };
}

