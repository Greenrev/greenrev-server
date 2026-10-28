import { Notification } from "../models/Notification";
import { getIO } from "../socket";
import { User } from "../models/User";
import { Resend } from "resend";

let resend: Resend | null = null;
if (process.env.RESEND_API_KEY) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

export class NotificationService {
  /**
   * Dispatches a notification via DB, Socket.io, and Email (Resend)
   */
  static async dispatchNotification(params: {
    recipientId: string;
    title: string;
    message: string;
    type: string;
    relatedId?: string;
    /** In-app only when false — for high-volume, low-urgency notices. */
    sendEmail?: boolean;
  }) {
    const { recipientId, title, message, type, relatedId, sendEmail = true } = params;

    // 1. Save to DB
    let notification;
    try {
      notification = await Notification.create({
        recipientId,
        title,
        message,
        type,
        relatedId,
      });
    } catch (err) {
      console.error("Failed to save notification to DB", err);
    }

    // 2. Emit via Socket.io
    try {
      const io = getIO();
      // Emits only to the user's specific room
      io.to(recipientId.toString()).emit("notification", {
        id: notification?._id,
        title,
        message,
        type,
        relatedId,
        createdAt: notification?.createdAt || new Date(),
      });
    } catch (err) {
      console.error("Failed to emit socket notification", err);
    }

    // 3. Send Email via Resend (fire and forget)
    if (!sendEmail) return;
    try {
      const recipient = await User.findById(recipientId).select("email name");
      if (recipient && recipient.email && resend) {
        await resend.emails.send({
          from: process.env.EMAIL_FROM || "GreenRev <info@greenrevs.com>",
          to: recipient.email,
          subject: title,
          html: `<p>Hi ${recipient.name || "User"},</p><p>${message}</p><p>Regards,<br/>GreenRev Team</p>`,
        });
        console.log(`Email notification sent to ${recipient.email}`);
      } else if (!resend) {
        console.log(`[Mock Email] To: ${recipient?.email} | Subject: ${title} | Body: ${message}`);
      }
    } catch (err) {
      console.error("Failed to send email via Resend", err);
    }
  }
}
