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

const router = Router();

const authLimiter = slidingWindowRateLimit({
  windowMs: 60_000,
  max: 20,
});

const sensitiveLimiter = slidingWindowRateLimit({
  windowMs: 60_000,
  max: 8,
});

// Admin sign-up checks a shared code — keep guessing slow.
const adminRegisterLimiter = slidingWindowRateLimit({
  windowMs: 15 * 60_000,
  max: 5,
});

router.post("/register", sensitiveLimiter, register);
router.post("/admin-register", adminRegisterLimiter, adminRegister);
router.post("/login", sensitiveLimiter, login);
router.post("/logout", authLimiter, logout);
router.post("/refresh", authLimiter, refresh);
router.get("/me", authLimiter, requireAuth, me);

router.post("/email/verify", authLimiter, verifyEmail);
router.post("/email/resend", authLimiter, resendVerification);

router.post("/password/forgot", authLimiter, forgotPassword);
router.post("/password/reset", authLimiter, resetPassword);

router.get("/google", authLimiter, googleStart);
router.get("/google/callback", authLimiter, googleCallback);

router.post("/mfa/setup", authLimiter, requireAuth, mfaSetup);
router.post("/mfa/verify", authLimiter, requireAuth, mfaVerify);

export default router;

