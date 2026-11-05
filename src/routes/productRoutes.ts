import { Router } from "express";
import {
  createProduct,
  getVendorProducts,
  getAllProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  bulkDeleteProducts,
} from "../controllers/productController";
import { createProductReview, getProductReviews } from "../controllers/reviewController";

import { requireAuth, optionalAuth } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";
import { userOrIp } from "../utils/rateKeys";

const router = Router();

// Browsing is generous — shoppers flick through many listings, often from shared mobile
// IPs. Writes stay tight, counted per account.
const readLimiter = slidingWindowRateLimit({ windowMs: 60_000, max: 300, keyGenerator: userOrIp });
const writeLimiter = slidingWindowRateLimit({ windowMs: 60_000, max: 30, keyGenerator: userOrIp });

router.post("/products", writeLimiter, requireAuth, createProduct);
router.get("/products", readLimiter, optionalAuth, getAllProducts);
router.get("/products/vendor", readLimiter, requireAuth, getVendorProducts);
router.delete("/products/bulk", writeLimiter, requireAuth, bulkDeleteProducts);
router.get("/products/:id", readLimiter, optionalAuth, getProduct);
router.put("/products/:id", writeLimiter, requireAuth, updateProduct);
router.delete("/products/:id", writeLimiter, requireAuth, deleteProduct);

router.post("/products/:id/reviews", writeLimiter, requireAuth, createProductReview);
router.get("/products/:id/reviews", readLimiter, getProductReviews);

export default router;
