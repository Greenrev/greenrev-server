import type { Request, Response } from "express";
import { User } from "../models/User";
import { AcquisitionRequest } from "../models/AcquisitionRequest";
import { AcquisitionEvent } from "../models/AcquisitionEvent";
import { ApiError } from "../utils/errors";
import { sendSuccess } from "../utils/apiResponse";
import { ApprovalRequest } from "../models/ApprovalRequest";
import { AuditLog } from "../models/AuditLog";
import { Role } from "../models/Role";
import type { CustomReq } from "../types/auth";

export async function listUsers(req: CustomReq, res: Response) {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const role = req.query.role as string;
  const skip = (page - 1) * limit;

  const matchStage: any = {};
  if (role) {
    matchStage.role = role;
  }

  const users = await User.find(matchStage)
    .skip(skip)
    .limit(limit)
    .populate("assignedRole", "name description level")
    .exec();

  const total = await User.countDocuments(matchStage);

  return sendSuccess(res, 200, { users, total, page, limit });
}

export async function updateUserStatus(req: CustomReq, res: Response) {
  const { id } = req.params;
  const { status } = req.body as { status: string };

  if (!["active", "suspended"].includes(status)) {
    throw new ApiError(400, "INVALID_STATUS", "Invalid status value");
  }

  const user = await User.findByIdAndUpdate(id, { status }, { new: true });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  return sendSuccess(res, 200, { user });
}

export async function updateUserRole(req: CustomReq, res: Response) {
  const { id } = req.params;
  const { role } = req.body as { role: string };

  if (!["customer", "vendor", "mechanic", "admin"].includes(role)) {
    throw new ApiError(400, "INVALID_ROLE", "Invalid role value");
  }

  const user = await User.findByIdAndUpdate(id, { role }, { new: true });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  return sendSuccess(res, 200, { user });
}

export async function updateUserTier(req: CustomReq, res: Response) {
  const { id } = req.params;
  const { verificationLevel } = req.body as { verificationLevel: string };

  if (!["basic", "individual", "business"].includes(verificationLevel)) {
    throw new ApiError(400, "INVALID_TIER", "Invalid tier value");
  }

  const user = await User.findByIdAndUpdate(id, { verificationLevel }, { new: true });
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  return sendSuccess(res, 200, { user });
}

export async function deleteUser(req: CustomReq, res: Response) {
  const { id } = req.params;

  const user = await User.findByIdAndDelete(id);
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  return sendSuccess(res, 204, { ok: true });
}

export async function listTransactions(req: CustomReq, res: Response) {
  const { status, userId } = req.query;
  const query: any = {};

  if (status) query.status = status;
  if (userId) query.userId = userId;

  const requests = await AcquisitionRequest.find(query).sort({ createdAt: -1 });

  return sendSuccess(res, 200, { requests });
}

export async function revokeUserSessions(req: CustomReq, res: Response) {
  const { id } = req.params;

  const user = await User.findById(id);
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  user.sessionVersion = (user.sessionVersion || 0) + 1;
  await user.save();

  return sendSuccess(res, 200, { ok: true, message: "User sessions revoked successfully" });
}

export async function requestUserSuspension(req: CustomReq, res: Response) {
  const { id } = req.params;
  const { reason } = req.body as { reason: string };

  if (!reason || reason.trim().length < 5) {
    throw new ApiError(400, "INVALID_REASON", "A detailed reason is required for suspension");
  }

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  if (user.status === "suspended") throw new ApiError(400, "INVALID_STATE", "User is already suspended");

  const request = await ApprovalRequest.create({
    action: "suspend_user",
    targetModel: "User",
    targetId: id as string,
    requestedData: { status: "suspended" },
    requesterId: req.user!.id,
    requesterRole: req.user!.role as string,
    reason: reason.trim(),
  });

  return sendSuccess(res, 201, { request });
}

export async function approveUserSuspension(req: CustomReq, res: Response) {
  const { requestId } = req.params;
  const { action, notes } = req.body as { action: "approve" | "reject"; notes?: string };

  const request = await ApprovalRequest.findById(requestId);
  if (!request) throw new ApiError(404, "REQUEST_NOT_FOUND", "Approval request not found");
  if (request.status !== "pending") throw new ApiError(400, "INVALID_STATE", "Request is already resolved");

  if (request.requesterId.toString() === req.user!.id) {
    throw new ApiError(403, "FORBIDDEN", "You cannot approve your own request (Maker-Checker violation)");
  }

  request.status = action === "approve" ? "approved" : "rejected";
  request.approverId = req.user!.id as any;
  request.approverRole = req.user!.role as string;
  request.approverNotes = notes || null;
  request.resolvedAt = new Date();
  await request.save();

  if (action === "approve") {
    const user = await User.findById(request.targetId);
    if (user) {
      const prevState = user.status;
      user.status = "suspended";
      await user.save();

      // Audit Log
      await AuditLog.create({
        adminId: request.requesterId,
        adminEmail: "requester", // Would populate this ideally
        action: "user.suspend",
        module: "Users",
        targetModel: "User",
        targetId: user._id.toString(),
        previousState: { status: prevState },
        newState: { status: "suspended" },
        reason: request.reason,
        approverId: req.user!.id,
      });
    }
  }

  return sendSuccess(res, 200, { request });
}

export async function listRoles(req: CustomReq, res: Response) {
  const roles = await Role.find().populate("permissions");
  return sendSuccess(res, 200, { roles });
}

export async function assignRole(req: CustomReq, res: Response) {
  const { id } = req.params;
  const { roleId } = req.body as { roleId: string };

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

  if (roleId) {
    const role = await Role.findById(roleId);
    if (!role) throw new ApiError(404, "ROLE_NOT_FOUND", "Role not found");
    user.assignedRole = role._id;
  } else {
    user.assignedRole = null;
  }

  await user.save();
  return sendSuccess(res, 200, { user });
}

export async function listAuditLogs(req: CustomReq, res: Response) {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const filter: any = {};
  if (req.query.module) filter.module = req.query.module as string;
  if (req.query.action) filter.action = req.query.action as string;
  if (req.query.adminId) filter.adminId = req.query.adminId as string;

  const logs = await AuditLog.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("adminId", "name email")
    .populate("approverId", "name email")
    .lean();

  const total = await AuditLog.countDocuments(filter);

  return sendSuccess(res, 200, { logs, total, page, limit });
}
