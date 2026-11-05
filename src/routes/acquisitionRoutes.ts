import { Router } from "express";
import {
  createRequest,
  getCustomerRequests,
  getVendorRequests,
  getVendorRequestCount,
  vendorAccept,
  uploadReceipt,
  vendorConfirmPayment,
  customerConfirmCompleted,
} from "../controllers/acquisitionController";
import { createReview, getVendorReviews } from "../controllers/reviewController";
import { getMessages, sendMessage } from "../controllers/messageController";
import { requireAuth } from "../middleware/auth";
import { slidingWindowRateLimit } from "../middleware/rateLimit";
import { userOrIp } from "../utils/rateKeys";

const router = Router();

// Per account: the deal chat polls for messages every few seconds while it's open.
const limiter = slidingWindowRateLimit({ windowMs: 60_000, max: 120, keyGenerator: userOrIp });

// Acquisition Requests
router.post("/acquisition-requests", limiter, requireAuth, createRequest);
router.get("/acquisition-requests", limiter, requireAuth, getCustomerRequests);
router.get("/acquisition-requests/vendor", limiter, requireAuth, getVendorRequests);
router.get("/acquisition-requests/vendor/count", limiter, requireAuth, getVendorRequestCount);
router.patch("/acquisition-requests/:id/vendor/accept", limiter, requireAuth, vendorAccept);
router.post("/acquisition-requests/:id/receipt", limiter, requireAuth, uploadReceipt);
router.post("/acquisition-requests/:id/vendor/confirm-payment", limiter, requireAuth, vendorConfirmPayment);
router.post("/acquisition-requests/:id/client/confirm-completed", limiter, requireAuth, customerConfirmCompleted);

// Messages
router.get("/acquisition-requests/:id/messages", limiter, requireAuth, getMessages);
router.post("/acquisition-requests/:id/messages", limiter, requireAuth, sendMessage);

// Reviews
router.post("/acquisition-requests/:id/review", limiter, requireAuth, createReview);
router.get("/reviews/vendor/:vendorId", limiter, getVendorReviews);

export default router;
