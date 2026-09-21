import { Request, Response } from "express";
import { Ticket } from "../models/Ticket";
import { sendSuccess, sendError } from "../utils/apiResponse";

// User: Create a ticket
export const createTicket = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { subject, initialMessage } = req.body;

    const ticket = await Ticket.create({
      userId,
      subject,
      messages: [{ senderId: userId, content: initialMessage }],
    });

    return sendSuccess(res, 201, ticket);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to create ticket" });
  }
};

// User: Get their own tickets
export const getUserTickets = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const tickets = await Ticket.find({ userId }).sort({ createdAt: -1 });
    return sendSuccess(res, 200, tickets);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to fetch tickets" });
  }
};

// Admin: Get all tickets
export const getAllTickets = async (req: Request, res: Response) => {
  try {
    const tickets = await Ticket.find()
      .populate("userId", "name email role")
      .populate("assignedTo", "name email")
      .sort({ createdAt: -1 });
    return sendSuccess(res, 200, tickets);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to fetch all tickets" });
  }
};

// Admin/User: Reply to ticket
export const replyToTicket = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { content, isInternal } = req.body;
    const senderId = (req as any).user.id;
    const role = (req as any).user.role;

    const ticket = await Ticket.findById(id);
    if (!ticket) return sendError(res, 404, { code: "ERROR", message: "Ticket not found" });

    if (role !== "admin" && ticket.userId.toString() !== senderId) {
      return sendError(res, 403, { code: "ERROR", message: "Not authorized to reply to this ticket" });
    }

    ticket.messages.push({
      senderId,
      content,
      isInternal: role === "admin" ? !!isInternal : false,
      createdAt: new Date(),
    } as any);

    if (role === "admin" && ticket.status === "OPEN") {
      ticket.status = "IN_PROGRESS";
    }

    await ticket.save();

    // Re-fetch to populate if needed
    const updatedTicket = await Ticket.findById(id)
      .populate("userId", "name email")
      .populate("assignedTo", "name email")
      .populate("messages.senderId", "name email role");

    return sendSuccess(res, 200, updatedTicket);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to reply to ticket" });
  }
};

// Admin: Update Ticket Status
export const updateTicketStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, priority, assignedTo } = req.body;

    const updateFields: any = {};
    if (status) updateFields.status = status;
    if (priority) updateFields.priority = priority;
    if (assignedTo !== undefined) updateFields.assignedTo = assignedTo || null;

    const ticket = await Ticket.findByIdAndUpdate(id, updateFields, { new: true })
      .populate("userId", "name email")
      .populate("assignedTo", "name email");

    if (!ticket) return sendError(res, 404, { code: "ERROR", message: "Ticket not found" });
    return sendSuccess(res, 200, ticket);
  } catch (error: any) {
    return sendError(res, 500, { code: "ERROR", message: error.message || "Failed to update ticket" });
  }
};
