import { Request, Response } from "express";
import { Booking } from "../models/Booking";
import { VerificationRequest } from "../models/VerificationRequest";
import { Review } from "../models/Review";
import { sendSuccess, sendError } from "../utils/apiResponse";

// Bookings
export const getAllBookings = async (req: Request, res: Response) => {
  try {
    const bookings = await Booking.find()
      .populate("userId", "name email")
      .populate("mechanicId", "name email")
      .sort({ createdAt: -1 });
    
    return sendSuccess(res, 200, bookings);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to fetch bookings" });
  }
};

export const updateBookingStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["PENDING", "CONFIRMED", "REJECTED", "COMPLETED"].includes(status)) {
      return sendError(res, 400, { code: "ERROR", message: "Invalid status" });
    }

    const booking = await Booking.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    )
      .populate("userId", "name email")
      .populate("mechanicId", "name email");

    if (!booking) {
      return sendError(res, 404, { code: "ERROR", message: "Booking not found" });
    }

    return sendSuccess(res, 200, booking);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to update booking status" });
  }
};

// Verifications
export const getVerificationRequests = async (req: Request, res: Response) => {
  try {
    const requests = await VerificationRequest.find()
      .populate("user", "name email role verificationLevel")
      .populate("reviewedBy", "name email")
      .sort({ createdAt: -1 });
    
    return sendSuccess(res, 200, requests);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to fetch verification requests" });
  }
};

export const updateVerificationStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;
    const adminId = (req as any).user.id;

    if (!["pending", "approved", "rejected", "info_requested"].includes(status)) {
      return sendError(res, 400, { code: "ERROR", message: "Invalid status" });
    }

    const request = await VerificationRequest.findByIdAndUpdate(
      id,
      { 
        status, 
        adminNotes,
        reviewedBy: adminId
      },
      { new: true }
    ).populate("user", "name email role verificationLevel");

    if (!request) {
      return sendError(res, 404, { code: "ERROR", message: "Verification request not found" });
    }

    return sendSuccess(res, 200, request);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to update verification status" });
  }
};

// Reviews Moderation
export const getAllReviews = async (req: Request, res: Response) => {
  try {
    const reviews = await Review.find()
      .populate("customerId", "name email")
      .populate("vendorId", "name email")
      .sort({ createdAt: -1 });
    
    return sendSuccess(res, 200, reviews);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to fetch reviews" });
  }
};

export const deleteReview = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const review = await Review.findByIdAndDelete(id);
    
    if (!review) return sendError(res, 404, { code: "ERROR", message: "Review not found" });
    return sendSuccess(res, 200, { ok: true });
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to delete review" });
  }
};

