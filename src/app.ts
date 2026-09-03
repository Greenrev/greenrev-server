import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import healthRoutes from "./routes/healthRoutes";
import authRoutes from "./routes/authRoutes";
import rbacRoutes from "./routes/rbacRoutes";
import productRoutes from "./routes/productRoutes";
import profileRoutes from "./routes/profileRoutes";
import acquisitionRoutes from "./routes/acquisitionRoutes";
import adminAcquisitionRoutes from "./routes/adminAcquisitionRoutes";
import adminDashboardRoutes from "./routes/adminDashboardRoutes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import adminRoutes from "./routes/adminRoutes";
import supportRoutes from "./routes/supportRoutes";
import { env } from "./config/env";
import { sanitizeRequest } from "./middleware/sanitize";
import { requireHttps } from "./middleware/requireHttps";
import { requireCsrf } from "./middleware/csrf";
import expertRoutes from "./routes/expertRoutes";
import mechanicRoutes from "./routes/mechanicRoutes";
import bookingRoutes from "./routes/bookingRoutes";
import uploadRoutes from "./routes/uploadRoutes";
import { verificationRoutes } from "./routes/verificationRoutes";
import inquiryRoutes from "./routes/inquiryRoutes";
import vendorRoutes from "./routes/vendorRoutes";
import notificationRoutes from "./routes/notificationRoutes";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(requireHttps);
  // Disable HSTS in development — it causes browsers to refuse HTTP on localhost
  // after the first HTTPS response, which breaks cookie-based auth locally.
  app.use(
    helmet({
      hsts: env.nodeEnv === "production",
    }),
  );

  app.use(
    cors({
      origin: (_origin, callback) => callback(null, true),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));
  app.use(sanitizeRequest);
  app.use(requireCsrf);

  app.use("/api/v1", healthRoutes);
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1", rbacRoutes);
  app.use("/api/v1", productRoutes);
  app.use("/api/v1", profileRoutes);
  app.use("/api/v1", acquisitionRoutes);
  app.use("/api/v1", adminAcquisitionRoutes);
  app.use("/api/v1/admin", adminDashboardRoutes);
  app.use("/api/v1/admin", adminRoutes);
  app.use("/api/v1", supportRoutes);
  app.use("/api/v1", expertRoutes);
  app.use("/api/v1", mechanicRoutes);
  app.use("/api/v1", bookingRoutes);
  app.use("/api/v1", uploadRoutes);
  app.use("/api/v1/verification", verificationRoutes);
  app.use("/api/v1", inquiryRoutes);
  app.use("/api/v1", vendorRoutes);
  app.use("/api/v1", notificationRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
