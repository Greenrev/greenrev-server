import { Router } from "express";
import { getExperts, getExpertReviews, createExpertReview, createExpertMessage } from "../controllers/expertController";
import { optionalAuth, requireAuth } from "../middleware/auth";

const router = Router();

// Contact details are only included for signed-in users.
router.get("/experts", optionalAuth, getExperts);
router.get("/experts/:id/reviews", getExpertReviews);
router.post("/experts/:id/reviews", requireAuth, createExpertReview);
router.post("/experts/:id/messages", requireAuth, createExpertMessage);

export default router;
