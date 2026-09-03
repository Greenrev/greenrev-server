import { Response } from "express";
import { Notification } from "../models/Notification";
import type { CustomReq } from "../types/auth";

export const getMyNotifications = async (req: CustomReq, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const notifications = await Notification.find({ recipientId: user.id })
      .sort({ createdAt: -1 })
      .limit(50); // Get latest 50

    const unreadCount = await Notification.countDocuments({ recipientId: user.id, isRead: false });

    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
};

export const markAsRead = async (req: CustomReq, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { ids } = req.body; // Array of notification IDs to mark as read

    if (Array.isArray(ids) && ids.length > 0) {
      await Notification.updateMany(
        { _id: { $in: ids }, recipientId: user.id },
        { $set: { isRead: true } }
      );
    } else {
      // Mark all as read
      await Notification.updateMany(
        { recipientId: user.id, isRead: false },
        { $set: { isRead: true } }
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update notifications" });
  }
};
