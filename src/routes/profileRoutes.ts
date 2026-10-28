import { Router } from "express";
import { getProfile, updateProfile, getUserMessages, deleteProfile } from "../controllers/profileController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get("/profile", requireAuth, getProfile);
router.put("/profile", requireAuth, updateProfile);
router.delete("/profile", requireAuth, deleteProfile);
router.get("/profile/messages", requireAuth, getUserMessages);

export default router;
