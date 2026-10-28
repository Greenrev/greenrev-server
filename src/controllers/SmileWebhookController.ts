/**
 * Smile ID Webhook Handler
 * ------------------------
 * Smile ID will POST results here when async verification jobs complete.
 * Set SMILE_CALLBACK_URL in your .env to your public server URL + "/api/v1/verification/webhook"
 * e.g. https://api.greenrev.com/api/v1/verification/webhook
 *
 * Smile ID signs each request using your API key — we verify the signature
 * before processing to prevent spoofed callbacks.
 */

import type { Request, Response } from "express";
import { Signature } from "smile-identity-core";
import { User } from "../models/User";
import { VerificationRequest } from "../models/VerificationRequest";
import { SMILE_PASS_CODES } from "../services/SmileIdentityService";

const PARTNER_ID = process.env.SMILE_PARTNER_ID ?? "";
const API_KEY = process.env.SMILE_API_KEY ?? "";

export async function smileWebhookHandler(req: Request, res: Response): Promise<void> {
  // Acknowledge immediately — Smile ID expects a 200 within a few seconds
  res.status(200).json({ received: true });

  try {
    const payload = req.body;

    // ── Signature verification ────────────────────────────────────────────────
    // Prevent spoofed webhooks by confirming the incoming signature
    if (PARTNER_ID && API_KEY) {
      const sig = new Signature(PARTNER_ID, API_KEY);
      const isValid = sig.confirm_signature(
        payload.timestamp,
        payload.signature,
      );
      if (!isValid) {
        console.error("[SmileID Webhook] Invalid signature — ignoring payload.");
        return;
      }
    }

    const userId = payload.PartnerParams?.user_id ?? payload.partner_params?.user_id;
    const jobId = payload.PartnerParams?.job_id ?? payload.partner_params?.job_id;
    const resultCode = payload.ResultCode ?? payload.result_code;
    const resultText = payload.ResultText ?? payload.result_text ?? "Verification processed.";
    const jobType = payload.PartnerParams?.job_type ?? payload.partner_params?.job_type;

    if (!userId) {
      console.error("[SmileID Webhook] Missing user_id in payload.");
      return;
    }

    const passed = SMILE_PASS_CODES.includes(String(resultCode)); // Exact or Partial Match
    const status = passed ? "approved" : "rejected";

    // Prefer the exact request this job was submitted as; fall back to the user's latest pending one.
    const request =
      (jobId && (await VerificationRequest.findOne({ smileJobId: jobId }))) ||
      (await VerificationRequest.findOne({ user: userId, status: { $in: ["pending", "info_requested"] } }).sort({
        createdAt: -1,
      }));

    if (!request) {
      console.error(`[SmileID Webhook] No verification request found for user ${userId} / job ${jobId}.`);
      return;
    }

    request.status = status;
    if (!passed) request.adminNotes = resultText;
    await request.save();

    const user = await User.findById(userId).select("verificationStatus verificationLevel");
    if (!user) return;

    if (passed) {
      // Level comes from what was requested (job type is only a fallback: 6 = Business Verification).
      const level = request.levelRequested ?? (Number(jobType) === 6 ? "business" : "individual");
      user.verificationStatus = "verified";
      user.verificationLevel = level;
      await user.save();
      console.log(`[SmileID Webhook] ✅ User ${userId} verified as ${level}.`);
    } else {
      // Never downgrade an already-verified user (e.g. a failed business upgrade).
      if (user.verificationStatus !== "verified") {
        user.verificationStatus = "rejected";
        await user.save();
      }
      console.log(`[SmileID Webhook] ❌ Verification failed for user ${userId}: ${resultText}`);
    }
  } catch (err) {
    console.error("[SmileID Webhook] Error processing payload:", err);
  }
}
