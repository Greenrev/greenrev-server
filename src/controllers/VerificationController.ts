import type { Response } from "express";
import { VerificationRequest } from "../models/VerificationRequest";
import { User } from "../models/User";
import type { CustomReq } from "../types/auth";
import { ApiError } from "../utils/errors";
import { SmileIdentityService, type SmileResult } from "../services/SmileIdentityService";

type Level = "individual" | "business";
const LEVEL_RANK: Record<string, number> = { basic: 0, individual: 1, business: 2 };

/**
 * Stop duplicate submissions before we call (and pay) Smile ID again:
 * - already verified at this level or higher, or
 * - a previous request is still being processed.
 */
async function assertCanSubmit(userId: string, level: Level) {
  const user = await User.findById(userId).select("verificationStatus verificationLevel").lean();
  if (!user) throw new ApiError(404, "NOT_FOUND", "User not found");

  if (user.verificationStatus === "verified" && LEVEL_RANK[user.verificationLevel ?? "basic"] >= LEVEL_RANK[level]) {
    throw new ApiError(409, "ALREADY_VERIFIED", "Your account is already verified at this level.");
  }

  const existingRequest = await VerificationRequest.findOne({ user: userId, status: { $in: ["pending", "info_requested"] } });
  if (existingRequest) {
    throw new ApiError(400, "BAD_REQUEST", "You already have a pending verification request.");
  }
  return user;
}

/** Persist the Smile outcome on the request and the user, then respond. */
async function recordResult(
  res: Response,
  userId: string,
  level: Level,
  currentUser: { verificationStatus?: string | null },
  smileResult: SmileResult,
  fields: Record<string, unknown>,
) {
  const base = { user: userId, levelRequested: level, smileJobId: smileResult.jobId, ...fields };

  if (!smileResult.success) {
    await VerificationRequest.create({ ...base, status: "rejected", adminNotes: smileResult.message });
    throw new ApiError(400, "VERIFICATION_FAILED", smileResult.message);
  }

  if (smileResult.pending) {
    // Async Smile job: the webhook decides. Don't verify the user yet.
    const request = await VerificationRequest.create({ ...base, status: "pending" });
    if (currentUser.verificationStatus !== "verified") {
      await User.findByIdAndUpdate(userId, { verificationStatus: "pending" });
    }
    return res.status(202).json({ success: true, data: { request, pending: true, message: smileResult.message } });
  }

  const request = await VerificationRequest.create({ ...base, status: "approved" });
  await User.findByIdAndUpdate(userId, { verificationStatus: "verified", verificationLevel: level });
  return res.status(201).json({ success: true, data: { request, pending: false } });
}

export const VerificationController = {
  async submitIndividual(req: CustomReq, res: Response) {
    const userId = req.user?.id as string;
    const { documentType, documentNumber, selfieUrl, nin } = req.body;

    const finalDocType = documentType || "NIN";
    const finalDocNumber = documentNumber || nin;

    if (!finalDocNumber || !selfieUrl) {
      throw new ApiError(400, "BAD_REQUEST", "Document number and selfieUrl are required");
    }

    const currentUser = await assertCanSubmit(userId, "individual");
    const smileResult = await SmileIdentityService.verifyIndividual(finalDocType, finalDocNumber, selfieUrl, userId);

    await recordResult(res, userId, "individual", currentUser, smileResult, {
      documentType: finalDocType,
      documentNumber: finalDocNumber,
      nin: finalDocType === "NIN" ? finalDocNumber : undefined, // Legacy support
      selfieUrl,
    });
  },

  async submitBusiness(req: CustomReq, res: Response) {
    const userId = req.user?.id as string;
    const { cacNumber, cacDocumentUrl, directorIdUrl, businessAddress, bankAccountNumber, bankCode } = req.body;

    if (!cacNumber || !cacDocumentUrl || !directorIdUrl || !businessAddress) {
      throw new ApiError(400, "BAD_REQUEST", "Missing required business verification fields");
    }

    const currentUser = await assertCanSubmit(userId, "business");
    const smileResult = await SmileIdentityService.verifyBusiness(cacNumber, userId);

    await recordResult(res, userId, "business", currentUser, smileResult, {
      cacNumber,
      cacDocumentUrl,
      directorIdUrl,
      businessAddress,
      bankAccountNumber,
      bankCode,
    });
  },

  async getStatus(req: CustomReq, res: Response) {
    const userId = req.user?.id;
    const request = await VerificationRequest.findOne({ user: userId }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        status: req.user?.verificationStatus,
        level: req.user?.verificationLevel,
        latestRequest: request || null,
      },
    });
  },
};
