import type { Response } from "express";
import mongoose from "mongoose";
import { AcquisitionRequest } from "../models/AcquisitionRequest";
import { AcquisitionEvent } from "../models/AcquisitionEvent";
import type { CustomReq } from "../types/auth";
import { sendError, sendSuccess } from "../utils/apiResponse";

export async function adminListAcquisitions(req: CustomReq, res: Response) {
  try {
    if (!req.user) return sendError(res, 401, { code: "UNAUTHORIZED", message: "Authentication required" });
    if (req.user.role !== "admin") return sendError(res, 403, { code: "FORBIDDEN", message: "Admin access only" });

    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const flagged = typeof req.query.flagged === "string" ? req.query.flagged : undefined;

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (flagged === "true") filter.adminFlaggedAt = { $ne: null };
    if (flagged === "false") filter.adminFlaggedAt = null;

    const items = await AcquisitionRequest.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    return sendSuccess(res, 200, { requests: items });
  } catch (error) {
    console.error("Error listing acquisitions:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Failed to fetch transactions" });
  }
}

export async function adminGetAcquisitionEvents(req: CustomReq, res: Response) {
  try {
    if (!req.user) return sendError(res, 401, { code: "UNAUTHORIZED", message: "Authentication required" });
    if (req.user.role !== "admin") return sendError(res, 403, { code: "FORBIDDEN", message: "Admin access only" });

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return sendError(res, 400, { code: "VALIDATION_ERROR", message: "Invalid id" });
    }

    const events = await AcquisitionEvent.find({ requestId: id }).sort({ createdAt: 1 }).lean();
    return sendSuccess(res, 200, { events });
  } catch (error) {
    console.error("Error fetching acquisition events:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Failed to fetch events" });
  }
}

export async function adminFlagAcquisition(req: CustomReq, res: Response) {
  try {
    if (!req.user) return sendError(res, 401, { code: "UNAUTHORIZED", message: "Authentication required" });
    if (req.user.role !== "admin") return sendError(res, 403, { code: "FORBIDDEN", message: "Admin access only" });

    const { id } = req.params;
    const { reason } = req.body as { reason?: string };
    if (!reason || typeof reason !== "string" || reason.trim().length < 3) {
      return sendError(res, 400, { code: "VALIDATION_ERROR", message: "Reason is required" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await AcquisitionRequest.findByIdAndUpdate(
        id,
        { $set: { adminFlaggedAt: new Date(), adminFlagReason: reason.trim() } },
        { new: true, session },
      );
      if (!updated) {
        await session.abortTransaction();
        return sendError(res, 404, { code: "NOT_FOUND", message: "Transaction not found" });
      }

      await AcquisitionEvent.create(
        [
          {
            requestId: updated._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "admin_flagged",
            fromStatus: null,
            toStatus: null,
            metadata: { reason: reason.trim() },
          },
        ],
        { session },
      );

      await session.commitTransaction();
      return sendSuccess(res, 200, { request: updated });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error flagging acquisition:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Failed to flag transaction" });
  }
}

export async function adminResolveAcquisition(req: CustomReq, res: Response) {
  try {
    if (!req.user) return sendError(res, 401, { code: "UNAUTHORIZED", message: "Authentication required" });
    if (req.user.role !== "admin") return sendError(res, 403, { code: "FORBIDDEN", message: "Admin access only" });

    const { id } = req.params;
    const { resolution } = req.body as { resolution?: string };
    if (!resolution || typeof resolution !== "string" || resolution.trim().length < 3) {
      return sendError(res, 400, { code: "VALIDATION_ERROR", message: "Resolution is required" });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await AcquisitionRequest.findByIdAndUpdate(
        id,
        { $set: { adminResolvedAt: new Date(), adminResolution: resolution.trim() } },
        { new: true, session },
      );
      if (!updated) {
        await session.abortTransaction();
        return sendError(res, 404, { code: "NOT_FOUND", message: "Transaction not found" });
      }

      await AcquisitionEvent.create(
        [
          {
            requestId: updated._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "admin_resolved",
            fromStatus: null,
            toStatus: null,
            metadata: { resolution: resolution.trim() },
          },
        ],
        { session },
      );

      await session.commitTransaction();
      return sendSuccess(res, 200, { request: updated });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error resolving acquisition:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Failed to resolve transaction" });
  }
}

