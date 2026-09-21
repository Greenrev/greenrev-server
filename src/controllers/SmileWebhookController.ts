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

    const passed = resultCode === "1010" || resultCode === "1011"; // Exact or Partial Match
    const status = passed ? "approved" : "rejected";

    // Update the verification request
    await VerificationRequest.findOneAndUpdate(
      { user: userId },
      { status },
      { sort: { createdAt: -1 }, new: true },
    );

    if (passed) {
      // Determine tier from job type (1 = Basic KYC / Individual, 6 = Business Verification)
      const isBusinessJob = Number(jobType) === 6;
      await User.findByIdAndUpdate(userId, {
        verificationStatus: "verified",
        verificationLevel: isBusinessJob ? "business" : "individual",
      });

      console.log(`[SmileID Webhook] ✅ User ${userId} verified as ${isBusinessJob ? "business" : "individual"}.`);
    } else {
      console.log(`[SmileID Webhook] ❌ Verification failed for user ${userId}: ${resultText}`);
    }
  } catch (err) {
    console.error("[SmileID Webhook] Error processing payload:", err);
  }
}
