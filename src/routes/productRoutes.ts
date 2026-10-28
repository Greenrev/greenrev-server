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

const router = Router();

const productLimiter = slidingWindowRateLimit({
  windowMs: 60_000,
  max: 20,
});

router.post("/products", productLimiter, requireAuth, createProduct);
router.get("/products", productLimiter, optionalAuth, getAllProducts);
router.get("/products/vendor", productLimiter, requireAuth, getVendorProducts);
router.delete("/products/bulk", productLimiter, requireAuth, bulkDeleteProducts);
router.get("/products/:id", productLimiter, optionalAuth, getProduct);
router.put("/products/:id", productLimiter, requireAuth, updateProduct);
router.delete("/products/:id", productLimiter, requireAuth, deleteProduct);

router.post("/products/:id/reviews", productLimiter, requireAuth, createProductReview);
router.get("/products/:id/reviews", productLimiter, getProductReviews);

export default router;
