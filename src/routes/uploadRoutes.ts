import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import { uploadProductMedia } from "../controllers/uploadController";
import { requireAuth, requireRole } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";
import { ApiError } from "../utils/errors";

const router = Router();

const MAX_FILE_SIZE_MB = 25;
const MAX_FILES = 10;

// Same formats the vendor "add product" form accepts: images plus 3D models.
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const MODEL_EXTENSIONS = new Set([".glb", ".gltf"]);

// Use memory storage for multer to avoid local file system writes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_FILES,
  },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, accept?: boolean) => void) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.has(ext) && file.mimetype.startsWith("image/");
    const isModel = MODEL_EXTENSIONS.has(ext);
    if (isImage || isModel) {
      cb(null, true);
      return;
    }
    cb(new ApiError(400, "UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${file.originalname}`) as unknown as Error);
  },
});

const uploadLimiter = slidingWindowRateLimit({
  windowMs: 60_000,
  max: 10,
});

/** Turn multer's own errors (size / count limits) into clean 400s instead of 500s. */
function parseFiles(req: Request, res: Response, next: NextFunction) {
  upload.array("files", MAX_FILES)(req, res, (err: unknown) => {
    const multerErr = err as { name?: string; code?: string; message?: string } | undefined;
    if (multerErr?.name === "MulterError") {
      const message =
        multerErr.code === "LIMIT_FILE_SIZE"
          ? `Each file must be ${MAX_FILE_SIZE_MB}MB or smaller`
          : multerErr.code === "LIMIT_FILE_COUNT" || multerErr.code === "LIMIT_UNEXPECTED_FILE"
            ? `Upload at most ${MAX_FILES} files in the "files" field`
            : (multerErr.message ?? "Upload rejected");
      next(new ApiError(400, "UPLOAD_REJECTED", message));
      return;
    }
    next(err);
  });
}

// Authenticate and authorise BEFORE multer reads anything into memory.
router.post("/upload", uploadLimiter, requireAuth, requireRole(["vendor", "admin"]), parseFiles, uploadProductMedia);

export default router;
