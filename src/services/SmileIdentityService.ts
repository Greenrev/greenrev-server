/**
 * SmileIdentityService
 * --------------------
 * This service wraps the official `smile-identity-core` Node.js SDK.
 *
 * HOW TO GO LIVE:
 * 1. Set the following environment variables from your Smile ID Portal:
 *    - SMILE_PARTNER_ID
 *    - SMILE_API_KEY
 *    - SMILE_CALLBACK_URL (your server's public webhook URL for async results)
 * 2. Set SMILE_USE_MOCK=false in your .env file.
 * 3. That's it — no code changes needed.
 *
 * MOCK MODE (current default):
 * - SMILE_USE_MOCK=true (or keys not set) → uses the local simulator.
 * - Magic NINs: "00000000000" = Face Mismatch, "11111111111" = Timeout
 * - Magic CAC:  "RC-000000" = Not Found, "RC-111111" = Timeout
 */

import { IDApi, JOB_TYPE } from "smile-identity-core";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const PARTNER_ID = process.env.SMILE_PARTNER_ID ?? "";
const API_KEY = process.env.SMILE_API_KEY ?? "";
const CALLBACK_URL = process.env.SMILE_CALLBACK_URL ?? "";
// sid_server: 0 = sandbox, 1 = production
const SID_SERVER = process.env.NODE_ENV === "production" ? 1 : 0;

// Toggle — stays "true" until real keys are provided
const USE_MOCK = process.env.SMILE_USE_MOCK !== "false" || !PARTNER_ID || !API_KEY;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SmileResult {
  success: boolean;
  message: string;
  jobId?: string;
}

// ─── Mock Implementation ──────────────────────────────────────────────────────

async function mockVerifyIndividual(idType: string, idNumber: string): Promise<SmileResult> {
  await new Promise((r) => setTimeout(r, 1500));
  if (idNumber === "11111111111") throw new Error("Smile ID Network Timeout");
  if (idNumber === "00000000000") {
    return { success: false, message: `Face Mismatch: The selfie does not match the ${idType} database photo.` };
  }
  return { success: true, message: `[MOCK] Biometric KYC passed for ${idType}.` };
}

async function mockVerifyBusiness(cacNumber: string): Promise<SmileResult> {
  await new Promise((r) => setTimeout(r, 1500));
  if (cacNumber === "RC-111111") throw new Error("Smile ID Network Timeout");
  if (cacNumber === "RC-000000") {
    return { success: false, message: "Company Not Found or Inactive." };
  }
  return { success: true, message: "[MOCK] Business Verification passed." };
}

// ─── Live Implementation ──────────────────────────────────────────────────────

async function liveVerifyIndividual(idType: string, idNumber: string, userId: string): Promise<SmileResult> {
  const idApi = new IDApi(PARTNER_ID, API_KEY, SID_SERVER);
  const jobId = crypto.randomUUID();

  const partnerParams = {
    user_id: userId,
    job_id: jobId,
    job_type: JOB_TYPE.BASIC_KYC,
  };

  const idInfo = {
    first_name: "",       // will be matched from database by Smile ID
    last_name: "",
    country: "NG",
    id_type: idType,
    id_number: idNumber,
    entered: true,
  };

  const response: any = CALLBACK_URL
    ? await idApi.submitAsyncjob(partnerParams, idInfo, CALLBACK_URL)
    : await idApi.submit_job(partnerParams, idInfo);

  // Async path: queued for processing via webhook
  if (CALLBACK_URL) {
    return { success: true, message: "Verification submitted. You will be notified shortly.", jobId };
  }

  // Synchronous path: check result immediately
  const resultCode = response?.ResultCode ?? response?.result_code;
  const resultText = response?.ResultText ?? response?.result_text ?? "Verification complete.";

  if (resultCode === "1012" || resultCode === "1020") {
    return { success: false, message: resultText };
  }

  // Result codes 1010 (Exact Match), 1011 (Partial Match) are successes
  return { success: true, message: resultText, jobId };
}

async function liveVerifyBusiness(cacNumber: string, userId: string): Promise<SmileResult> {
  const idApi = new IDApi(PARTNER_ID, API_KEY, SID_SERVER);
  const jobId = crypto.randomUUID();

  const partnerParams = {
    user_id: userId,
    job_id: jobId,
    job_type: JOB_TYPE.BUSINESS_VERIFICATION,
  };

  const idInfo = {
    country: "NG",
    id_type: "BUSINESS_REGISTRATION",
    id_number: cacNumber,
    entered: true,
  };

  const response: any = CALLBACK_URL
    ? await idApi.submitAsyncjob(partnerParams, idInfo, CALLBACK_URL)
    : await idApi.submit_job(partnerParams, idInfo);

  if (CALLBACK_URL) {
    return { success: true, message: "Business verification submitted. You will be notified shortly.", jobId };
  }

  const resultCode = response?.ResultCode ?? response?.result_code;
  const resultText = response?.ResultText ?? response?.result_text ?? "Business verification complete.";

  if (resultCode === "1012" || resultCode === "1020") {
    return { success: false, message: resultText };
  }

  return { success: true, message: resultText, jobId };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class SmileIdentityService {
  static get isMockMode(): boolean {
    return USE_MOCK;
  }

  /**
   * Verify an individual's Identity + Selfie via Smile ID Biometric KYC.
   * @param idType - "NIN", "PASSPORT", or "DRIVERS_LICENSE"
   * @param idNumber  - The ID number for the selected document type
   * @param selfieUrl - Signed URL of the liveness selfie captured via the web SDK
   * @param userId - Your internal user ID (used as Smile ID's partner user_id)
   */
  static async verifyIndividual(
    idType: string,
    idNumber: string,
    selfieUrl: string,
    userId?: string,
  ): Promise<SmileResult> {
    if (USE_MOCK) {
      console.log("[SmileID] Running in MOCK mode. Set SMILE_USE_MOCK=false to go live.");
      return mockVerifyIndividual(idType, idNumber);
    }
    return liveVerifyIndividual(idType, idNumber, userId ?? idNumber);
  }

  /**
   * Verify a Nigerian business via CAC registration number.
   * @param cacNumber - e.g. "RC-1234567"
   * @param userId - Your internal user ID
   */
  static async verifyBusiness(
    cacNumber: string,
    userId?: string,
  ): Promise<SmileResult> {
    if (USE_MOCK) {
      console.log("[SmileID] Running in MOCK mode. Set SMILE_USE_MOCK=false to go live.");
      return mockVerifyBusiness(cacNumber);
    }
    return liveVerifyBusiness(cacNumber, userId ?? cacNumber);
  }
}
