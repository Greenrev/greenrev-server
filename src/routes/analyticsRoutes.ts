import { Router } from "express";
import { getAnalyticsOverview, trackVisit } from "../controllers/analyticsController";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";

const router = Router();

router.post("/analytics/visit", slidingWindowRateLimit({ windowMs: 60_000, max: 30 }), optionalAuth, trackVisit);
router.get("/admin/analytics/overview", requireAuth, requireRole(["admin"]), getAnalyticsOverview);

export default router;
