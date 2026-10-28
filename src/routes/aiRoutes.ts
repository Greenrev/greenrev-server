import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { extractListingFields, audioFormatFor } from "../controllers/aiController";
import { requireAuth, requireRole } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";
import { ApiError } from "../utils/errors";

const router = Router();

const MAX_IMAGES = 4;
const MAX_FILE_SIZE_MB = 10;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: MAX_IMAGES + 1 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, accept?: boolean) => void) => {
    const ok =
      (file.fieldname === "images" && IMAGE_TYPES.has(file.mimetype)) ||
      (file.fieldname === "audio" && Boolean(audioFormatFor(file.mimetype)));
    if (ok) {
      cb(null, true);
      return;
    }
    cb(
      new ApiError(400, "UNSUPPORTED_FILE_TYPE", `Unsupported ${file.fieldname === "audio" ? "audio" : "image"} type: ${file.mimetype}`) as unknown as Error,
    );
  },
});

// AI calls cost money per request, so keep this tighter than plain uploads.
const aiLimiter = slidingWindowRateLimit({ windowMs: 60_000, max: 6 });

function parseFiles(req: Request, res: Response, next: NextFunction) {
  upload.fields([
    { name: "images", maxCount: MAX_IMAGES },
    { name: "audio", maxCount: 1 },
  ])(req, res, (err: unknown) => {
    const multerErr = err as { name?: string; code?: string; message?: string } | undefined;
    if (multerErr?.name === "MulterError") {
      const message =
        multerErr.code === "LIMIT_FILE_SIZE"
          ? `Each file must be ${MAX_FILE_SIZE_MB}MB or smaller`
          : multerErr.code === "LIMIT_FILE_COUNT" || multerErr.code === "LIMIT_UNEXPECTED_FILE"
            ? `Send up to ${MAX_IMAGES} "images" and one "audio" file`
            : (multerErr.message ?? "Upload rejected");
      next(new ApiError(400, "UPLOAD_REJECTED", message));
      return;
    }
    next(err);
  });
}

// Authenticate and authorise BEFORE multer reads anything into memory.
router.post(
  "/ai/listing-extract",
  aiLimiter,
  requireAuth,
  requireRole(["vendor", "admin"]),
  parseFiles,
  extractListingFields,
);

export default router;
