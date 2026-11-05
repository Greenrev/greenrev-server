import { Router } from "express";
import {
  forgotPassword,
  googleCallback,
  googleStart,
  login,
  logout,
  me,
  refresh,
  register,
  adminRegister,
  resendVerification,
  resetPassword,
  verifyEmail,
  mfaSetup,
  mfaVerify,
} from "../controllers/authController";
import { requireAuth } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";
import { userOrIp } from "../utils/rateKeys";

const router = Router();

// Many Nigerian mobile users share one public IP (carrier-grade NAT), so per-IP limits
// must be generous; brute-force protection is per account / per email instead.

// Session checks run on every page load: count them per signed-in account.
const sessionLimiter = slidingWindowRateLimit({ windowMs: 60_000, max: 120, keyGenerator: userOrIp });

// A whole network signing in at once is normal; a single IP hammering isn't.
const networkLimiter = slidingWindowRateLimit({ windowMs: 60_000, max: 60 });

// Guessing passwords or 6-digit PINs for one email: 10 tries per 15 minutes.
const perEmailLimiter = slidingWindowRateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return email ? `email:${email}` : `ip:${req.ip ?? "unknown"}`;
  },
});

// Admin sign-up checks a shared code — keep guessing slow.
const adminRegisterLimiter = slidingWindowRateLimit({
  windowMs: 15 * 60_000,
  max: 5,
});

router.post("/register", networkLimiter, perEmailLimiter, register);
router.post("/admin-register", adminRegisterLimiter, adminRegister);
router.post("/login", networkLimiter, perEmailLimiter, login);
router.post("/logout", sessionLimiter, logout);
router.post("/refresh", sessionLimiter, refresh);
router.get("/me", sessionLimiter, requireAuth, me);

router.post("/email/verify", networkLimiter, perEmailLimiter, verifyEmail);
router.post("/email/resend", networkLimiter, perEmailLimiter, resendVerification);

router.post("/password/forgot", networkLimiter, perEmailLimiter, forgotPassword);
router.post("/password/reset", networkLimiter, resetPassword);

router.get("/google", networkLimiter, googleStart);
router.get("/google/callback", networkLimiter, googleCallback);

router.post("/mfa/setup", sessionLimiter, requireAuth, mfaSetup);
router.post("/mfa/verify", sessionLimiter, requireAuth, mfaVerify);

export default router;

