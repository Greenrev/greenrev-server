import { Router } from "express";
import {
  adminCreateListingOption,
  adminListListingOptions,
  adminPendingListingOptionCount,
  adminUpdateListingOption,
  getListingOptions,
} from "../controllers/listingOptionsController";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

router.get("/listing-options", getListingOptions);

const admin = [requireAuth, requireRole(["admin"])];
router.get("/admin/listing-options", ...admin, adminListListingOptions);
router.get("/admin/listing-options/pending-count", ...admin, adminPendingListingOptionCount);
router.post("/admin/listing-options", ...admin, adminCreateListingOption);
router.patch("/admin/listing-options/:id", ...admin, adminUpdateListingOption);

export default router;
