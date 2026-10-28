import { Router } from "express";
import { geoReverse, geoSearch } from "../controllers/geoController";
import { requireAuth, requireRole } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";

const router = Router();

// Used by experts setting their workshop location; lookups cost money or have usage limits.
const geoLimiter = slidingWindowRateLimit({ windowMs: 60_000, max: 30 });
const experts = [geoLimiter, requireAuth, requireRole(["mechanic", "admin"])];

router.get("/geo/search", ...experts, geoSearch);
router.get("/geo/reverse", ...experts, geoReverse);

export default router;
