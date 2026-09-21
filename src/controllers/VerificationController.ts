import type { Response } from "express";
import { VerificationRequest } from "../models/VerificationRequest";
import { User } from "../models/User";
import type { CustomReq } from "../types/auth";
import { ApiError } from "../utils/errors";
import { SmileIdentityService } from "../services/SmileIdentityService";

export const VerificationController = {
  async submitIndividual(req: CustomReq, res: Response) {
    const userId = req.user?.id;
    const { documentType, documentNumber, selfieUrl, nin } = req.body;

    const finalDocType = documentType || "NIN";
    const finalDocNumber = documentNumber || nin;

    if (!finalDocNumber || !selfieUrl) {
      throw new ApiError(400, "BAD_REQUEST", "Document number and selfieUrl are required");
    }

    const existingRequest = await VerificationRequest.findOne({ user: userId, status: { $in: ["pending", "info_requested"] } });
    if (existingRequest) {
      throw new ApiError(400, "BAD_REQUEST", "You already have a pending verification request.");
    }

    // Call Smile ID Service (Live or Mock)
    const smileResult = await SmileIdentityService.verifyIndividual(finalDocType, finalDocNumber, selfieUrl, userId as string);

    if (!smileResult.success) {
      // Create rejected record
      await VerificationRequest.create({
        user: userId,
        levelRequested: "individual",
        documentType: finalDocType,
        documentNumber: finalDocNumber,
        nin: finalDocType === "NIN" ? finalDocNumber : undefined, // Legacy support
        selfieUrl,
        status: "rejected",
      });
      throw new ApiError(400, "VERIFICATION_FAILED", smileResult.message);
    }

    // Auto-approve testing flow
    const newRequest = await VerificationRequest.create({
      user: userId,
      levelRequested: "individual",
      documentType: finalDocType,
      documentNumber: finalDocNumber,
      nin: finalDocType === "NIN" ? finalDocNumber : undefined, // Legacy support
      selfieUrl,
      status: "approved",
    });

    await User.findByIdAndUpdate(userId, { 
      verificationStatus: "verified",
      verificationLevel: "individual" 
    });

    res.status(201).json({ success: true, data: { request: newRequest } });
  },

  async submitBusiness(req: CustomReq, res: Response) {
    const userId = req.user?.id;
    const { cacNumber, cacDocumentUrl, directorIdUrl, businessAddress, bankAccountNumber, bankCode } = req.body;

    if (!cacNumber || !cacDocumentUrl || !directorIdUrl || !businessAddress) {
      throw new ApiError(400, "BAD_REQUEST", "Missing required business verification fields");
    }

    const existingRequest = await VerificationRequest.findOne({ user: userId, status: { $in: ["pending", "info_requested"] } });
    if (existingRequest) {
      throw new ApiError(400, "BAD_REQUEST", "You already have a pending verification request.");
    }

    // Call Smile ID Mock Service
    const smileResult = await SmileIdentityService.verifyBusiness(cacNumber, userId as string);

    if (!smileResult.success) {
      await VerificationRequest.create({
        user: userId,
        levelRequested: "business",
        cacNumber,
        cacDocumentUrl,
        directorIdUrl,
        businessAddress,
        bankAccountNumber,
        bankCode,
        status: "rejected"
      });
      throw new ApiError(400, "VERIFICATION_FAILED", smileResult.message);
    }

    // Auto-approve testing flow
    const newRequest = await VerificationRequest.create({
      user: userId,
      levelRequested: "business",
      cacNumber,
      cacDocumentUrl,
      directorIdUrl,
      businessAddress,
      bankAccountNumber,
      bankCode,
      status: "approved"
    });

    await User.findByIdAndUpdate(userId, { 
      verificationStatus: "verified",
      verificationLevel: "business" 
    });

    res.status(201).json({ success: true, data: { request: newRequest } });
  },

  async getStatus(req: CustomReq, res: Response) {
    const userId = req.user?.id;
    const request = await VerificationRequest.findOne({ user: userId }).sort({ createdAt: -1 });
    
    // Fallback to user status if no request found
    let status = req.user?.verificationStatus;
    let level = req.user?.verificationLevel;

    res.status(200).json({
      success: true,
      data: {
        status,
        level,
        latestRequest: request || null,
      },
    });
  },
};
