import type { Response } from "express";
import { User } from "../models/User";
import { ApiError } from "../utils/errors";
import { sendSuccess } from "../utils/apiResponse";
import type { CustomReq } from "../types/auth";
import { uploadImage } from "../utils/cloudinary";
import { ExpertMessage } from "../models/ExpertMessage";
import { sendEmail } from "../services/emailService";

export async function getProfile(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  return sendSuccess(res, 200, {
    profile: {
      name: user.name ?? "",
      bio: user.bio ?? "",
      phone: user.phone ?? "",
      specialization: user.specialization ?? [],
      hourlyRate: user.hourlyRate ?? 0,
      city: user.city ?? "",
      country: user.country ?? "",
      address: user.address ?? "",
      lat: user.lat ?? 0,
      lng: user.lng ?? 0,
      state: user.state ?? "",
      serviceRadiusKm: user.serviceRadiusKm ?? 25,
      locationPrivacy: user.locationPrivacy ?? "exact",
      profileImage: user.profileImage ?? null,
    },
  });
}

export async function updateProfile(req: CustomReq, res: Response) {
  try {
    if (!req.user) {
      throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
    }

    const { name, bio, phone, specialization, hourlyRate, profileImageBase64 } = req.body as Record<string, unknown>;

    const user = await User.findById(req.user.id);
    if (!user) {
      throw new ApiError(404, "USER_NOT_FOUND", "User not found");
    }

    if (typeof name === "string") user.name = name;
    if (typeof bio === "string") user.bio = bio;
    if (typeof phone === "string") user.phone = phone;
    if (Array.isArray(specialization)) {
      user.specialization = specialization.filter(s => typeof s === "string");
    }
    if (typeof hourlyRate === "number") user.hourlyRate = hourlyRate;
    else if (typeof hourlyRate === "string" && !isNaN(Number(hourlyRate))) {
      user.hourlyRate = Number(hourlyRate);
    }

    if (typeof profileImageBase64 === "string" && profileImageBase64) {
      const imageUrl = await uploadImage(profileImageBase64, "greenrev_profiles");
      user.profileImage = imageUrl;
    }

    await user.save();

    return sendSuccess(res, 200, {
      profile: {
        name: user.name ?? "",
        bio: user.bio ?? "",
        phone: user.phone ?? "",
        specialization: user.specialization ?? [],
        hourlyRate: user.hourlyRate ?? 0,
        profileImage: user.profileImage ?? null,
      },
    });
  } catch (error) {
    console.error("Failed to update profile", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
}

export const SERVICE_RADII_KM = [0, 5, 10, 25, 50, 100] as const;

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiError(400, "VALIDATION_ERROR", `${field} must be text`);
  const v = value.trim().replace(/\s+/g, " ");
  if (v.length > max) throw new ApiError(400, "VALIDATION_ERROR", `${field} is too long`);
  return v;
}

function coordinate(value: unknown, field: string, limit: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > limit) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be between -${limit} and ${limit}`);
  }
  return Math.round(n * 1e6) / 1e6;
}

/** PATCH /mechanic/location — the map pin is required; address fields describe it. */
export async function updateLocation(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const body = req.body as Record<string, unknown>;
  const lat = coordinate(body.lat, "Latitude", 90);
  const lng = coordinate(body.lng, "Longitude", 180);
  if (lat === 0 && lng === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "Drop the pin on your workshop before saving");
  }

  const address = optionalText(body.address, "Street address", 200);
  const city = optionalText(body.city, "City", 80);
  const state = optionalText(body.state, "State", 80);
  const country = optionalText(body.country, "Country", 80);

  let serviceRadiusKm: number | undefined;
  if (body.serviceRadiusKm !== undefined) {
    serviceRadiusKm = Number(body.serviceRadiusKm);
    if (!SERVICE_RADII_KM.includes(serviceRadiusKm as (typeof SERVICE_RADII_KM)[number])) {
      throw new ApiError(400, "VALIDATION_ERROR", `Service radius must be one of ${SERVICE_RADII_KM.join(", ")} km`);
    }
  }
  const privacy = body.locationPrivacy;
  if (privacy !== undefined && privacy !== "exact" && privacy !== "approximate") {
    throw new ApiError(400, "VALIDATION_ERROR", 'locationPrivacy must be "exact" or "approximate"');
  }

  const user = await User.findById(req.user.id);
  if (!user) {
    throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  }

  user.lat = lat;
  user.lng = lng;
  if (address !== undefined) user.address = address;
  if (city !== undefined) user.city = city;
  if (state !== undefined) user.state = state;
  if (country !== undefined) user.country = country;
  if (serviceRadiusKm !== undefined) user.serviceRadiusKm = serviceRadiusKm;
  if (privacy !== undefined) user.locationPrivacy = privacy;
  await user.save();

  return sendSuccess(res, 200, {
    location: {
      address: user.address ?? "",
      city: user.city ?? "",
      state: user.state ?? "",
      country: user.country ?? "",
      lat: user.lat,
      lng: user.lng,
      serviceRadiusKm: user.serviceRadiusKm ?? 25,
      locationPrivacy: user.locationPrivacy ?? "exact",
    },
  });
}

export async function getExpertMessages(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const messages = await ExpertMessage.find({ expertId: req.user.id })
    .sort({ createdAt: -1 })
    .lean();

  return sendSuccess(res, 200, { messages });
}

export async function replyToExpertMessage(req: CustomReq, res: Response) {
  if (!req.user) {
    throw new ApiError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const messageId = req.params.id;
  const { reply } = req.body;

  if (!reply || typeof reply !== "string" || !reply.trim()) {
    throw new ApiError(400, "INVALID_INPUT", "Reply content is required");
  }

  const message = await ExpertMessage.findById(messageId);
  if (!message) {
    throw new ApiError(404, "MESSAGE_NOT_FOUND", "Message not found");
  }

  if (message.expertId.toString() !== req.user.id) {
    throw new ApiError(403, "FORBIDDEN", "Not authorized to reply to this message");
  }

  message.reply = reply.trim();
  message.replyDate = new Date();
  message.status = "REPLIED";

  await message.save();

  // Find the expert's name
  const expert = await User.findById(req.user.id).select("name email");
  const expertName = expert?.name || "An Expert";

  // Send an email to the user
  const emailHtml = `
    <h2>You received a reply from ${expertName}!</h2>
    <p>They responded to the message you sent on GreenRev.</p>
    <div style="background: #f4f4f4; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <p><strong>Your Original Message:</strong></p>
      <p style="color: #666;">${message.message}</p>
    </div>
    <div style="background: #eef8ee; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <p><strong>${expertName}'s Reply:</strong></p>
      <p>${message.reply}</p>
    </div>
    <p>Log in to GreenRev to view all your messages.</p>
  `;

  await sendEmail({
    to: message.senderEmail,
    subject: `Reply from ${expertName} - GreenRev`,
    html: emailHtml,
  }).catch(err => console.error("Failed to send expert reply email:", err));

  return sendSuccess(res, 200, { message });
}
