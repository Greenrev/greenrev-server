import type { Request, Response } from "express";
import { env } from "../config/env";
import { User } from "../models/User";
import { AuthToken } from "../models/AuthToken";
import { RefreshToken } from "../models/RefreshToken";
import { ApiError } from "../utils/errors";
import { sendSuccess } from "../utils/apiResponse";
import {
  assertStrongPassword,
  hashPassword,
  verifyPassword,
} from "../utils/password";
import {
  randomToken,
  sha256Base64Url,
  hmacSha256Base64Url,
} from "../utils/crypto";
import { signAccessToken } from "../utils/jwt";
import { baseCookieOptions, csrfCookieOptions } from "../utils/cookies";
import {
  createRefreshTokenRecord,
  getValidRefreshTokenRecord,
  rotateRefreshToken,
} from "../services/tokenService";
import { sendEmail } from "../services/emailService";
import { getVerificationEmailTemplate, getPasswordResetTemplate } from "../utils/emailTemplates";
import type { CustomReq, UserRole } from "../types/auth";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user: any) {
  return {
    id: String(user._id),
    email: user.email,
    role: user.role,
    name: user.name ?? null,
    companyName: user.companyName ?? null,
    garageName: user.garageName ?? null,
    isEmailVerified: Boolean(user.isEmailVerified),
  };
}

function setAuthCookies(
  res: Response,
  input: { accessToken: string; refreshToken: string; csrfToken: string },
) {
  res.cookie("access_token", input.accessToken, {
    ...baseCookieOptions(),
    maxAge: env.accessTokenTtlSeconds * 1000,
  });
  res.cookie("refresh_token", input.refreshToken, {
    ...baseCookieOptions(),
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
  res.cookie("csrf_token", input.csrfToken, {
    ...csrfCookieOptions(),
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie("access_token", { ...baseCookieOptions() });
  res.clearCookie("refresh_token", { ...baseCookieOptions() });
  res.clearCookie("csrf_token", { ...csrfCookieOptions() });
}

export async function adminRegister(req: Request, res: Response) {
  const { email, password, name, activationCode } =
    req.body as Record<string, unknown>;

  if (typeof email !== "string" || !emailRegex.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email");
  }
  if (typeof password !== "string") {
    throw new ApiError(400, "INVALID_PASSWORD", "Invalid password");
  }
  if (typeof activationCode !== "string" || activationCode !== "GREENREV") {
    throw new ApiError(403, "INVALID_ACTIVATION_CODE", "Invalid activation code");
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    throw new ApiError(400, "INVALID_NAME", "Invalid name");
  }

  try {
    assertStrongPassword(password);
  } catch (e) {
    throw new ApiError(400, "WEAK_PASSWORD", (e as Error).message);
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new ApiError(409, "EMAIL_IN_USE", "Email already in use");
  }

  const passwordHash = await hashPassword(password);
  const user = await User.create({
    email: email.toLowerCase(),
    passwordHash,
    role: "admin" as UserRole,
    name: typeof name === "string" ? name : null,
    isEmailVerified: false,
  });

  const verifyPin = Math.floor(100000 + Math.random() * 900000).toString();
  await AuthToken.create({
    userId: user._id,
    type: "email_verify",
    tokenHash: sha256Base64Url(verifyPin),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log(`\n========== OTP GENERATED ==========`);
  console.log(`Email: ${user.email}`);
  console.log(`OTP: ${verifyPin}`);
  console.log(`===================================\n`);

  await sendEmail({
    to: user.email,
    subject: "Verify your admin email",
    html: getVerificationEmailTemplate(verifyPin),
  });

  return sendSuccess(res, 201, { user: publicUser(user) });
}

export async function register(req: Request, res: Response) {
  const { email, password, role, name, companyName, garageName } =
    req.body as Record<string, unknown>;

  if (typeof email !== "string" || !emailRegex.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email");
  }
  if (typeof password !== "string") {
    throw new ApiError(400, "INVALID_PASSWORD", "Invalid password");
  }
  if (
    typeof role !== "string" ||
    !["customer", "vendor", "mechanic", "admin"].includes(role)
  ) {
    throw new ApiError(400, "INVALID_ROLE", "Invalid role");
  }
  if (name !== undefined && name !== null && typeof name !== "string") {
    throw new ApiError(400, "INVALID_NAME", "Invalid name");
  }
  if (
    companyName !== undefined &&
    companyName !== null &&
    typeof companyName !== "string"
  ) {
    throw new ApiError(400, "INVALID_COMPANY", "Invalid company name");
  }
  if (
    garageName !== undefined &&
    garageName !== null &&
    typeof garageName !== "string"
  ) {
    throw new ApiError(400, "INVALID_GARAGE", "Invalid garage name");
  }

  if (
    role === "vendor" &&
    (!companyName ||
      typeof companyName !== "string" ||
      companyName.trim().length < 2)
  ) {
    throw new ApiError(400, "INVALID_COMPANY", "Company name is required");
  }
  if (
    role === "mechanic" &&
    (!garageName ||
      typeof garageName !== "string" ||
      garageName.trim().length < 2)
  ) {
    throw new ApiError(400, "INVALID_GARAGE", "Garage name is required");
  }

  try {
    assertStrongPassword(password);
  } catch (e) {
    throw new ApiError(400, "WEAK_PASSWORD", (e as Error).message);
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new ApiError(409, "EMAIL_IN_USE", "Email already in use");
  }

  const passwordHash = await hashPassword(password);
  const user = await User.create({
    email: email.toLowerCase(),
    passwordHash,
    role: role as UserRole,
    name: typeof name === "string" ? name : null,
    companyName: typeof companyName === "string" ? companyName : null,
    garageName: typeof garageName === "string" ? garageName : null,
    isEmailVerified: false,
  });

  const verifyPin = Math.floor(100000 + Math.random() * 900000).toString();
  await AuthToken.create({
    userId: user._id,
    type: "email_verify",
    tokenHash: sha256Base64Url(verifyPin),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log(`\n========== OTP GENERATED ==========`);
  console.log(`Email: ${user.email}`);
  console.log(`OTP: ${verifyPin}`);
  console.log(`===================================\n`);

  await sendEmail({
    to: user.email,
    subject: "Verify your email",
    html: getVerificationEmailTemplate(verifyPin),
  });

  return sendSuccess(res, 201, { user: publicUser(user) });
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as Record<string, unknown>;

  if (typeof email !== "string" || !emailRegex.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email");
  }
  if (typeof password !== "string") {
    throw new ApiError(400, "INVALID_PASSWORD", "Invalid password");
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !user.passwordHash) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  }

  if (!user.isEmailVerified) {
    throw new ApiError(403, "EMAIL_NOT_VERIFIED", "Email not verified");
  }

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role as UserRole,
  });
  const { refreshToken, csrfToken } = await createRefreshTokenRecord(
    String(user._id),
  );

  setAuthCookies(res, { accessToken, refreshToken, csrfToken });

  return sendSuccess(res, 200, { user: publicUser(user), csrfToken, accessToken });
}

export async function me(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }
  // Return the token from cookies or header so the frontend can refresh its memory if needed
  const token = (req.cookies?.access_token) || (req.headers.authorization?.split(" ")[1]);
  return sendSuccess(res, 200, { user: req.user, csrfToken: req.cookies?.csrf_token, accessToken: token });
}

export async function refresh(req: CustomReq, res: Response) {
  const refreshToken = req.cookies?.refresh_token as string | undefined;
  if (!refreshToken) {
    throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token");
  }

  const {
    refreshToken: newRefresh,
    csrfToken,
    userId,
  } = await rotateRefreshToken(refreshToken);
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role as UserRole,
  });
  setAuthCookies(res, { accessToken, refreshToken: newRefresh, csrfToken });

  return sendSuccess(res, 200, { user: publicUser(user), csrfToken, accessToken });
}

export async function logout(req: Request, res: Response) {
  const refreshToken = req.cookies?.refresh_token as string | undefined;
  if (refreshToken) {
    const record = await getValidRefreshTokenRecord(refreshToken);
    if (record) {
      record.revokedAt = new Date();
      await record.save();
    }
  }

  clearAuthCookies(res);
  return sendSuccess(res, 200, { ok: true });
}

export async function verifyEmail(req: Request, res: Response) {
  const { pin, email } = req.body as Record<string, unknown>;
  if (typeof pin !== "string" || pin.length !== 6) {
    throw new ApiError(400, "INVALID_PIN", "Invalid PIN");
  }
  if (typeof email !== "string" || !emailRegex.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email");
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    throw new ApiError(400, "INVALID_PIN", "Invalid PIN or email");
  }

  const tokenHash = sha256Base64Url(pin);
  const record = await AuthToken.findOne({ tokenHash, type: "email_verify", userId: user._id });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, "INVALID_PIN", "Invalid PIN");
  }

  user.isEmailVerified = true;
  await user.save();

  record.usedAt = new Date();
  await record.save();

  return sendSuccess(res, 200, { ok: true });
}

export async function resendVerification(req: Request, res: Response) {
  const { email } = req.body as Record<string, unknown>;
  if (typeof email !== "string" || !emailRegex.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email");
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return sendSuccess(res, 200, { ok: true });
  }
  if (user.isEmailVerified) {
    return sendSuccess(res, 200, { ok: true });
  }

  const verifyPin = Math.floor(100000 + Math.random() * 900000).toString();
  await AuthToken.create({
    userId: user._id,
    type: "email_verify",
    tokenHash: sha256Base64Url(verifyPin),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log(`\n========== OTP GENERATED ==========`);
  console.log(`Email: ${user.email}`);
  console.log(`OTP: ${verifyPin}`);
  console.log(`===================================\n`);

  await sendEmail({
    to: user.email,
    subject: "Verify your email",
    html: getVerificationEmailTemplate(verifyPin),
  });

  return sendSuccess(res, 200, { ok: true });
}

export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body as Record<string, unknown>;
  if (typeof email !== "string" || !emailRegex.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Invalid email");
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return sendSuccess(res, 200, { ok: true });
  }

  const resetToken = randomToken(48);
  await AuthToken.create({
    userId: user._id,
    type: "password_reset",
    tokenHash: sha256Base64Url(resetToken),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const resetUrl = `${env.frontendUrl.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(resetToken)}`;
  await sendEmail({
    to: user.email,
    subject: "Reset your password",
    html: getPasswordResetTemplate(resetUrl),
  });

  return sendSuccess(res, 200, { ok: true });
}

export async function resetPassword(req: Request, res: Response) {
  const { token, newPassword } = req.body as Record<string, unknown>;
  if (typeof token !== "string" || token.length < 20) {
    throw new ApiError(400, "INVALID_TOKEN", "Invalid token");
  }
  if (typeof newPassword !== "string") {
    throw new ApiError(400, "INVALID_PASSWORD", "Invalid password");
  }

  try {
    assertStrongPassword(newPassword);
  } catch (e) {
    throw new ApiError(400, "WEAK_PASSWORD", (e as Error).message);
  }

  const tokenHash = sha256Base64Url(token);
  const record = await AuthToken.findOne({ tokenHash, type: "password_reset" });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, "INVALID_TOKEN", "Invalid token");
  }

  const user = await User.findById(record.userId);
  if (!user || !user.passwordHash) {
    throw new ApiError(400, "INVALID_TOKEN", "Invalid token");
  }

  user.passwordHash = await hashPassword(newPassword);
  await user.save();

  record.usedAt = new Date();
  await record.save();

  await RefreshToken.updateMany(
    { userId: user._id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  clearAuthCookies(res);

  return sendSuccess(res, 200, { ok: true });
}

function encodeOAuthState(data: Record<string, unknown>): string {
  const json = JSON.stringify({ ...data, iat: Date.now() });
  const payload = Buffer.from(json).toString("base64url");
  const sig = hmacSha256Base64Url(env.oauthStateSecret, payload);
  return `${payload}.${sig}`;
}

function decodeOAuthState(state: string): Record<string, unknown> {
  const [payload, sig] = state.split(".");
  if (!payload || !sig)
    throw new ApiError(400, "OAUTH_STATE_INVALID", "Invalid state");
  const expected = hmacSha256Base64Url(env.oauthStateSecret, payload);
  if (sig !== expected)
    throw new ApiError(400, "OAUTH_STATE_INVALID", "Invalid state");
  const json = Buffer.from(payload, "base64url").toString("utf8");
  const data = JSON.parse(json) as Record<string, unknown>;
  const iat = typeof data.iat === "number" ? data.iat : 0;
  if (Date.now() - iat > 10 * 60 * 1000) {
    throw new ApiError(400, "OAUTH_STATE_EXPIRED", "State expired");
  }
  return data;
}

export async function googleStart(req: Request, res: Response) {
  if (!env.googleClientId || !env.googleRedirectUri) {
    throw new ApiError(
      500,
      "GOOGLE_OAUTH_NOT_CONFIGURED",
      "Google OAuth not configured",
    );
  }

  const role = (req.query.role as string | undefined) ?? "customer";
  if (!["customer", "vendor", "mechanic", "admin"].includes(role)) {
    throw new ApiError(400, "INVALID_ROLE", "Invalid role");
  }

  const state = encodeOAuthState({ role, returnTo: req.query.returnTo ?? "/" });
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}

export async function googleCallback(req: Request, res: Response) {
  if (
    !env.googleClientId ||
    !env.googleClientSecret ||
    !env.googleRedirectUri
  ) {
    throw new ApiError(
      500,
      "GOOGLE_OAUTH_NOT_CONFIGURED",
      "Google OAuth not configured",
    );
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    throw new ApiError(400, "OAUTH_INVALID", "Invalid OAuth callback");
  }

  const stateData = decodeOAuthState(state);
  const role = (stateData.role as string | undefined) ?? "customer";
  const returnTo = (stateData.returnTo as string | undefined) ?? "/";

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleRedirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    throw new ApiError(
      400,
      "OAUTH_TOKEN_EXCHANGE_FAILED",
      "OAuth token exchange failed",
    );
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new ApiError(
      400,
      "OAUTH_TOKEN_EXCHANGE_FAILED",
      "OAuth token exchange failed",
    );
  }

  const profileRes = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { authorization: `Bearer ${tokenJson.access_token}` },
    },
  );

  if (!profileRes.ok) {
    throw new ApiError(
      400,
      "OAUTH_PROFILE_FAILED",
      "OAuth profile fetch failed",
    );
  }

  const profile = (await profileRes.json()) as {
    id: string;
    email: string;
    name?: string;
    verified_email?: boolean;
  };
  if (!profile.email || !profile.id) {
    throw new ApiError(
      400,
      "OAUTH_PROFILE_FAILED",
      "OAuth profile fetch failed",
    );
  }

  const email = profile.email.toLowerCase();
  let user = await User.findOne({ email });

  if (!user) {
    user = await User.create({
      email,
      name: profile.name ?? null,
      role: (["customer", "vendor", "mechanic", "admin"].includes(role)
        ? role
        : "customer") as UserRole,
      googleId: profile.id,
      passwordHash: null,
      isEmailVerified: Boolean(profile.verified_email ?? true),
    });
  } else {
    if (!user.googleId) user.googleId = profile.id;
    if (!user.isEmailVerified)
      user.isEmailVerified = Boolean(profile.verified_email ?? true);
    if (!user.name && profile.name) user.name = profile.name;
    await user.save();
  }

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role as UserRole,
  });
  const { refreshToken, csrfToken } = await createRefreshTokenRecord(
    String(user._id),
  );
  setAuthCookies(res, { accessToken, refreshToken, csrfToken });

  const redirectUrl = new URL(
    env.frontendUrl.replace(/\/$/, "") + "/oauth/callback",
  );
  redirectUrl.searchParams.set(
    "returnTo",
    typeof returnTo === "string" ? returnTo : "/",
  );
  res.redirect(redirectUrl.toString());
}

import speakeasy from "speakeasy";
import qrcode from "qrcode";

export async function mfaSetup(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  if (user.mfaEnabled) {
    throw new ApiError(400, "MFA_ALREADY_ENABLED", "MFA is already enabled on this account");
  }

  const secret = speakeasy.generateSecret({
    name: `GreenRev BackOffice (${user.email})`,
  });

  if (!secret.base32 || !secret.otpauth_url) {
    throw new ApiError(500, "MFA_SETUP_FAILED", "Failed to generate MFA secret");
  }

  user.mfaSecret = secret.base32;
  await user.save();

  const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

  return sendSuccess(res, 200, {
    secret: secret.base32,
    qrCodeUrl,
  });
}

export async function mfaVerify(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { token } = req.body as { token?: string };
  if (!token || typeof token !== "string" || token.length < 6) {
    throw new ApiError(400, "INVALID_TOKEN", "MFA token is required");
  }

  const user = await User.findById(req.user.id);
  if (!user || !user.mfaSecret) {
    throw new ApiError(400, "MFA_NOT_SETUP", "MFA is not set up on this account");
  }

  const verified = speakeasy.totp.verify({
    secret: user.mfaSecret,
    encoding: "base32",
    token: token.trim(),
  });

  if (!verified) {
    throw new ApiError(401, "INVALID_MFA_TOKEN", "Invalid MFA token");
  }

  if (!user.mfaEnabled) {
    user.mfaEnabled = true;
    await user.save();
  }

  return sendSuccess(res, 200, { ok: true });
}
