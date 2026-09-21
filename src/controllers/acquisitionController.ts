import type { Response } from "express";
import mongoose from "mongoose";
import { AcquisitionRequest } from "../models/AcquisitionRequest";
import { AcquisitionEvent } from "../models/AcquisitionEvent";
import { Product } from "../models/Product";
import { User } from "../models/User";
import { Review } from "../models/Review";
import type { CustomReq } from "../types/auth";
import { sendSuccess, sendError } from "../utils/apiResponse";
import type { AcquisitionStatus } from "../types/acquisition";
import { uploadImage } from "../utils/cloudinary";
import { sendEmail } from "../services/emailService";
import { getNewAcquisitionRequestTemplate } from "../utils/emailTemplates";
// ─── Customer: Create a request ──────────────────────────────────────────────
export async function createRequest(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "customer") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Only customers can place acquisition requests",
      });
    }

    const { productId, quantity, message } = req.body as {
      productId?: string;
      quantity?: number;
      message?: string;
    };

    if (!productId) {
      return sendError(res, 400, {
        code: "VALIDATION_ERROR",
        message: "Product ID is required",
      });
    }

    // Fetch product + vendor info
    const product = await Product.findById(productId).lean();
    if (!product) {
      return sendError(res, 404, {
        code: "NOT_FOUND",
        message: "Product not found",
      });
    }

    const vendor = await User.findById(product.vendorId)
      .select("name companyName email phone role")
      .lean();
    if (!vendor) {
      return sendError(res, 404, {
        code: "NOT_FOUND",
        message: "Vendor not found",
      });
    }
    if ((vendor as any).role !== "vendor") {
      return sendError(res, 400, {
        code: "INVALID_VENDOR",
        message: "Product vendor is not a vendor account",
      });
    }

    const customer = await User.findById(req.user.id)
      .select("name email phone")
      .lean();
    if (!customer) {
      return sendError(res, 404, {
        code: "NOT_FOUND",
        message: "Customer not found",
      });
    }

    // Check for an existing active request for same product if it's a vehicle
    if ((product as any).category === "vehicle") {
      const existing = await AcquisitionRequest.findOne({
        customerId: req.user.id,
        productId,
        status: {
          $in: ["pending", "accepted", "receipt_uploaded", "payment_confirmed"],
        },
      });
      if (existing) {
        return sendError(res, 409, {
          code: "DUPLICATE_REQUEST",
          message: "You already have an active request for this product",
        });
      }
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const created = await AcquisitionRequest.create(
        [
          {
            customerId: req.user.id,
            customerName: (customer as any).name || "Customer",
            customerEmail: (customer as any).email,
            customerPhone: (customer as any).phone || null,
            vendorId: product.vendorId,
            vendorName:
              (vendor as any).name || (vendor as any).companyName || "Vendor",
            vendorEmail: (vendor as any).email,
            vendorPhone: (vendor as any).phone || null,
            vendorCompanyName: (vendor as any).companyName || null,
            productId,
            productName: (product as any).name,
            productImage: (product as any).image,
            productPrice: (product as any).price,
            productMake: (product as any).make || null,
            quantity: quantity || 1,
            message: message || null,
            status: "pending",
          },
        ],
        { session },
      );

      await AcquisitionEvent.create(
        [
          {
            requestId: created[0]._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "created",
            fromStatus: null,
            toStatus: "pending",
            metadata: null,
          },
        ],
        { session },
      );

      await session.commitTransaction();

      // Send email to vendor
      try {
        await sendEmail({
          to: (vendor as any).email,
          subject: "New Acquisition Request on GreenRev",
          html: getNewAcquisitionRequestTemplate(
            (customer as any).name || "Customer",
            (product as any).name
          ),
        });
      } catch (emailErr) {
        console.error("Failed to send vendor notification email:", emailErr);
      }

      return sendSuccess(res, 201, { request: created[0] });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error creating acquisition request:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to create acquisition request",
    });
  }
}

function canRevealVendorContact(status: AcquisitionStatus): boolean {
  return status !== "pending";
}

// ─── Customer: Get their requests ────────────────────────────────────────────
export async function getCustomerRequests(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }

    const requests = await AcquisitionRequest.find({ customerId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    // Attach review data
    const requestIds = requests.map((r) => r._id);
    const reviews = await Review.find({
      acquisitionRequestId: { $in: requestIds },
    }).lean();
    const reviewMap = new Map(
      reviews.map((rv) => [rv.acquisitionRequestId!.toString(), rv]),
    );

    const enriched = requests.map((r) => {
      const reveal = canRevealVendorContact(r.status as AcquisitionStatus);
      return {
        ...r,
        vendorEmail: reveal ? (r as any).vendorEmail : null,
        vendorPhone: reveal ? (r as any).vendorPhone : null,
        vendorCompanyName: reveal ? (r as any).vendorCompanyName : null,
        review: reviewMap.get((r._id as any).toString()) || null,
      };
    });

    return sendSuccess(res, 200, { requests: enriched });
  } catch (error) {
    console.error("Error fetching customer requests:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to fetch requests",
    });
  }
}

// ─── Vendor: Get their incoming requests ────────────────────────────────────
export async function getVendorRequests(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "vendor" && req.user.role !== "admin") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Vendor access only",
      });
    }

    const requests = await AcquisitionRequest.find({ vendorId: req.user.id })
      .sort({ createdAt: -1 })
      .lean();

    return sendSuccess(res, 200, { requests });
  } catch (error) {
    console.error("Error fetching vendor requests:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to fetch requests",
    });
  }
}

// ─── Vendor: Get pending count (for notification badge) ─────────────────────
export async function getVendorRequestCount(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "vendor" && req.user.role !== "admin") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Vendor access only",
      });
    }

    const count = await AcquisitionRequest.countDocuments({
      vendorId: req.user.id,
      status: "pending",
    });

    return sendSuccess(res, 200, { count });
  } catch (error) {
    console.error("Error fetching vendor request count:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to fetch count",
    });
  }
}

export async function vendorAccept(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "vendor" && req.user.role !== "admin") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Vendor access only",
      });
    }

    const { id } = req.params;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await AcquisitionRequest.findOneAndUpdate(
        { _id: id, vendorId: req.user.id, status: "pending" },
        {
          $set: {
            status: "accepted",
            acceptedAt: new Date(),
            vendorSeen: true,
          },
        },
        { new: true, session },
      );
      if (!updated) {
        await session.abortTransaction();
        return sendError(res, 400, {
          code: "INVALID_STATE",
          message: "Request cannot be accepted",
        });
      }

      await AcquisitionEvent.create(
        [
          {
            requestId: updated._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "vendor_accepted",
            fromStatus: "pending",
            toStatus: "accepted",
            metadata: null,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      return sendSuccess(res, 200, { request: updated });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error accepting request:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to accept request",
    });
  }
}

export async function uploadReceipt(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "customer") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Customer access only",
      });
    }

    const { id } = req.params;
    const { receiptImageBase64 } = req.body as { receiptImageBase64?: string };
    if (
      !receiptImageBase64 ||
      typeof receiptImageBase64 !== "string"
    ) {
      return sendError(res, 400, {
        code: "VALIDATION_ERROR",
        message: "Receipt image is required",
      });
    }

    let receiptUrl = "";
    try {
      receiptUrl = await uploadImage(receiptImageBase64, "greenrev_receipts");
    } catch (err) {
      return sendError(res, 500, {
        code: "UPLOAD_ERROR",
        message: "Failed to upload receipt image to Cloudinary",
      });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await AcquisitionRequest.findOneAndUpdate(
        { _id: id, customerId: req.user.id, status: "accepted" },
        {
          $set: {
            status: "receipt_uploaded",
            receiptUrl,
            receiptUploadedAt: new Date(),
          },
        },
        { new: true, session },
      );
      if (!updated) {
        await session.abortTransaction();
        return sendError(res, 400, {
          code: "INVALID_STATE",
          message: "Receipt cannot be uploaded",
        });
      }

      await AcquisitionEvent.create(
        [
          {
            requestId: updated._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "receipt_uploaded",
            fromStatus: "accepted",
            toStatus: "receipt_uploaded",
            metadata: { receiptUrl },
          },
        ],
        { session },
      );

      await session.commitTransaction();
      return sendSuccess(res, 200, { request: updated });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error uploading receipt:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to upload receipt",
    });
  }
}

export async function vendorConfirmPayment(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "vendor" && req.user.role !== "admin") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Vendor access only",
      });
    }

    const { id } = req.params;
    const { amount } = req.body as { amount?: unknown };
    const parsed =
      typeof amount === "number"
        ? amount
        : typeof amount === "string"
          ? Number(amount)
          : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return sendError(res, 400, {
        code: "VALIDATION_ERROR",
        message: "Amount must be a positive number",
      });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await AcquisitionRequest.findOneAndUpdate(
        { _id: id, vendorId: req.user.id, status: "receipt_uploaded" },
        {
          $set: {
            status: "payment_confirmed",
            vendorPaymentAmount: parsed,
            vendorPaymentConfirmedAt: new Date(),
            vendorSeen: true,
          },
        },
        { new: true, session },
      );
      if (!updated) {
        await session.abortTransaction();
        return sendError(res, 400, {
          code: "INVALID_STATE",
          message: "Payment cannot be confirmed",
        });
      }

      await AcquisitionEvent.create(
        [
          {
            requestId: updated._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "payment_confirmed",
            fromStatus: "receipt_uploaded",
            toStatus: "payment_confirmed",
            metadata: { amount: parsed },
          },
        ],
        { session },
      );

      await session.commitTransaction();
      return sendSuccess(res, 200, { request: updated });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error confirming payment:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to confirm payment",
    });
  }
}

export async function customerConfirmCompleted(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
    }
    if (req.user.role !== "customer") {
      return sendError(res, 403, {
        code: "FORBIDDEN",
        message: "Customer access only",
      });
    }

    const { id } = req.params;
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await AcquisitionRequest.findOneAndUpdate(
        { _id: id, customerId: req.user.id, status: "payment_confirmed" },
        { $set: { status: "completed", completedAt: new Date() } },
        { new: true, session },
      );
      if (!updated) {
        await session.abortTransaction();
        return sendError(res, 400, {
          code: "INVALID_STATE",
          message: "Transaction cannot be completed",
        });
      }

      await AcquisitionEvent.create(
        [
          {
            requestId: updated._id,
            actorId: req.user.id,
            actorRole: req.user.role,
            action: "client_completed",
            fromStatus: "payment_confirmed",
            toStatus: "completed",
            metadata: null,
          },
        ],
        { session },
      );

      await session.commitTransaction();
      return sendSuccess(res, 200, { request: updated });
    } catch (e) {
      await session.abortTransaction();
      throw e;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Error completing transaction:", error);
    return sendError(res, 500, {
      code: "INTERNAL_ERROR",
      message: "Failed to complete transaction",
    });
  }
}
