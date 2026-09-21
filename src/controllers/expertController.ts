import type { Request, Response } from "express";
import { User } from "../models/User";
import { ExpertReview } from "../models/ExpertReview";
import { ExpertMessage } from "../models/ExpertMessage";
import { sendSuccess, sendError } from "../utils/apiResponse";
import type { CustomReq } from "../types/auth";
import { sendEmail } from "../services/emailService";

export async function getExperts(req: Request, res: Response) {
  try {
    const experts = await User.find({ role: "mechanic" })
      .select("-passwordHash -__v")
      .lean();

    // Aggregate ratings for all mechanics in one query
    const ids = experts.map((e) => e._id);
    const ratingsAgg = await ExpertReview.aggregate([
      { $match: { expertId: { $in: ids } } },
      {
        $group: {
          _id: "$expertId",
          averageRating: { $avg: "$rating" },
          reviewCount: { $sum: 1 },
        },
      },
    ]);

    const ratingsMap = new Map(
      ratingsAgg.map((r) => [r._id.toString(), { averageRating: r.averageRating, reviewCount: r.reviewCount }]),
    );

    const mappedExperts = experts.map((expert) => {
      const ratings = ratingsMap.get(expert._id.toString());
      return {
        id: expert._id.toString(),
        name: expert.name || expert.garageName || expert.companyName || "Unknown Expert",
        city: expert.city || "Unknown City",
        country: expert.country || "Unknown Country",
        address: expert.address || "",
        lat: expert.lat || 0,
        lng: expert.lng || 0,
        specialization: expert.specialization || [],
        hourlyRate: expert.hourlyRate || 0,
        phone: expert.phone || "",
        email: expert.email,
        // Return null image so the client can fall back to initials
        image: expert.profileImage || null,
        averageRating: ratings ? Math.round(ratings.averageRating * 10) / 10 : null,
        reviewCount: ratings?.reviewCount ?? 0,
      };
    });

    return sendSuccess(res, 200, { experts: mappedExperts });
  } catch (error) {
    console.error("Get experts error:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Server error" });
  }
}

export async function getExpertReviews(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const reviews = await ExpertReview.find({ expertId: id })
      .sort({ createdAt: -1 })
      .lean();

    return sendSuccess(res, 200, { reviews });
  } catch (error) {
    console.error("Get expert reviews error:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Server error" });
  }
}

export async function createExpertReview(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, { code: "UNAUTHENTICATED", message: "Login required to leave a review" });
    }

    const { id: expertId } = req.params;
    const { rating, comment } = req.body as { rating: unknown; comment?: unknown };

    if (typeof rating !== "number" || rating < 1 || rating > 5) {
      return sendError(res, 400, { code: "INVALID_RATING", message: "Rating must be between 1 and 5" });
    }

    // Prevent experts from reviewing themselves
    if (req.user.id === expertId) {
      return sendError(res, 400, { code: "SELF_REVIEW", message: "You cannot review yourself" });
    }

    const author = await User.findById(req.user.id).select("name email").lean();
    const authorName = (author?.name as string | null) ?? (author?.email as string) ?? "Anonymous";

    const review = await ExpertReview.findOneAndUpdate(
      { expertId, authorId: req.user.id },
      {
        expertId,
        authorId: req.user.id,
        authorName,
        rating,
        comment: typeof comment === "string" ? comment.trim() : "",
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return sendSuccess(res, 200, { review });
  } catch (error) {
    console.error("Create expert review error:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Failed to save review" });
  }
}

export async function createExpertMessage(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      return sendError(res, 401, { code: "UNAUTHENTICATED", message: "Login required to send a message" });
    }

    const { id: expertId } = req.params;
    const { message } = req.body as { message?: string };

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return sendError(res, 400, { code: "INVALID_INPUT", message: "Message cannot be empty" });
    }

    const expert = await User.findById(expertId).lean();
    if (!expert || expert.role !== "mechanic") {
      return sendError(res, 404, { code: "NOT_FOUND", message: "Expert not found" });
    }

    const sender = await User.findById(req.user.id).lean();
    if (!sender) {
      return sendError(res, 404, { code: "NOT_FOUND", message: "Sender not found" });
    }

    const senderName = (sender.name as string | null) ?? (sender.email as string);
    const senderEmail = sender.email as string;
    const senderPhone = (sender.phone as string | undefined);

    const expertMessage = await ExpertMessage.create({
      expertId: expertId as string,
      senderId: sender._id,
      senderName,
      senderEmail,
      senderPhone,
      message: message.trim(),
    });

    // Send email notification to expert
    if (expert.email) {
      const emailHtml = `
        <h2>New Message from ${senderName}</h2>
        <p>You have received a new message on your GreenRev expert profile.</p>
        <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Message:</strong></p>
          <p>${message.trim()}</p>
        </div>
        <p><strong>Contact Details:</strong></p>
        <ul>
          <li>Name: ${senderName}</li>
          <li>Email: ${senderEmail}</li>
          ${senderPhone ? `<li>Phone: ${senderPhone}</li>` : ''}
        </ul>
        <p>Log in to your expert dashboard to respond or manage your messages.</p>
      `;

      await sendEmail({
        to: expert.email as string,
        subject: `New Message from ${senderName} - GreenRev`,
        html: emailHtml,
      }).catch(err => console.error("Failed to send expert message email:", err));
    }

    return sendSuccess(res, 201, { message: expertMessage });
  } catch (error) {
    console.error("Create expert message error:", error);
    return sendError(res, 500, { code: "INTERNAL_ERROR", message: "Failed to send message" });
  }
}
