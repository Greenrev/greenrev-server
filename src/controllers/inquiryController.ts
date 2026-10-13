import type { Request, Response } from "express";
import { Inquiry } from "../models/Inquiry";
import { sendEmail } from "../services/emailService";
import { env } from "../config/env";
import { sendSuccess } from "../utils/apiResponse";
import { ApiError } from "../utils/errors";

export async function createInquiry(req: Request, res: Response) {
  const { name, email, phone, message } = req.body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ApiError(400, "INVALID_NAME", "Name is required");
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", "Valid email is required");
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new ApiError(400, "INVALID_MESSAGE", "Message is required");
  }

  const inquiry = await Inquiry.create({
    name,
    email,
    phone: typeof phone === "string" ? phone : undefined,
    message,
    status: "NEW",
  });

  // Notify admin
  const adminEmail = env.emailFrom || "admin@greenrevs.com";
  try {
    await sendEmail({
      to: adminEmail,
      subject: `New Inquiry from ${name}`,
      html: `
        <h2>New Inquiry Received</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone || "N/A"}</p>
        <hr />
        <p><strong>Message:</strong></p>
        <p>${message}</p>
      `,
    });
  } catch (error) {
    console.error("Failed to send inquiry email to admin:", error);
    // Continue even if email fails
  }

  return sendSuccess(res, 201, { inquiry });
}

export async function listInquiries(req: Request, res: Response) {
  const search = ((req.query.search || req.query.q) as string | undefined)?.trim();
  const filter: any = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { message: { $regex: search, $options: "i" } },
    ];
  }
  const inquiries = await Inquiry.find(filter).sort({ createdAt: -1 });
  return sendSuccess(res, 200, { inquiries });
}

export async function updateInquiryStatus(req: Request, res: Response) {
  const { id } = req.params;
  const { status } = req.body as Record<string, unknown>;

  if (typeof status !== "string" || !["NEW", "READ", "REPLIED"].includes(status)) {
    throw new ApiError(400, "INVALID_STATUS", "Invalid status");
  }

  const inquiry = await Inquiry.findById(id);
  if (!inquiry) {
    throw new ApiError(404, "NOT_FOUND", "Inquiry not found");
  }

  inquiry.status = status as "NEW" | "READ" | "REPLIED";
  await inquiry.save();

  return sendSuccess(res, 200, { inquiry });
}
