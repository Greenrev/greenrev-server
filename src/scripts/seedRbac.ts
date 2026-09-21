import "dotenv/config";
import mongoose from "mongoose";
import { Permission } from "../models/Permission";
import { Role } from "../models/Role";
import { User } from "../models/User";
import { hashPassword } from "../utils/password";

export const PERMISSION_LIST = [
  // Customer Permissions
  { name: "customer.view", module: "Customers", description: "View customer accounts" },
  { name: "customer.edit", module: "Customers", description: "Edit customer accounts" },
  { name: "customer.suspend", module: "Customers", description: "Suspend customer accounts" },
  { name: "customer.restore", module: "Customers", description: "Restore customer accounts" },
  
  // Vendor Permissions
  { name: "vendor.view", module: "Vendors", description: "View vendor accounts" },
  { name: "vendor.verify", module: "Vendors", description: "Verify vendor onboarding" },
  { name: "vendor.approve", module: "Vendors", description: "Approve vendor accounts" },
  { name: "vendor.suspend", module: "Vendors", description: "Suspend vendor accounts" },

  // Mechanic Permissions
  { name: "mechanic.view", module: "Mechanics", description: "View mechanic accounts" },
  { name: "mechanic.approve", module: "Mechanics", description: "Approve mechanic accounts" },
  
  // Listing Permissions
  { name: "listing.view", module: "Listings", description: "View vehicle and parts listings" },
  { name: "listing.approve", module: "Listings", description: "Approve listings" },
  { name: "listing.reject", module: "Listings", description: "Reject listings" },
  { name: "listing.suspend", module: "Listings", description: "Suspend listings" },

  // Order/Acquisition Permissions
  { name: "order.view", module: "Orders", description: "View order and acquisition status" },
  { name: "order.manage", module: "Orders", description: "Manage order progression and deliveries" },

  // Transaction Permissions
  { name: "transaction.view", module: "Transactions", description: "View transactions" },
  { name: "transaction.flag", module: "Transactions", description: "Flag transactions" },

  // Support / Dispute Permissions
  { name: "support.manage", module: "Support", description: "Manage support tickets and communicate with users" },
  { name: "dispute.view", module: "Disputes", description: "View disputes" },
  { name: "dispute.manage", module: "Disputes", description: "Initiate and escalate disputes" },
  { name: "dispute.resolve", module: "Disputes", description: "Resolve disputes" },

  // Administrator Permissions
  { name: "role.view", module: "Roles", description: "View staff roles and permissions" },
  { name: "role.assign", module: "Roles", description: "Assign roles to staff" },
  { name: "role.approve", module: "Roles", description: "Approve role changes" },

  // Technical & Config Permissions
  { name: "config.view", module: "Configuration", description: "View technical configuration" },
  { name: "config.modify", module: "Configuration", description: "Modify system configuration" },
  { name: "technical_logs.view", module: "Technical", description: "View technical logs and errors" },

  // Audit Permissions
  { name: "audit.view", module: "Audit", description: "View immutable audit logs" },
];

export async function seedRbac() {
  console.log("Seeding RBAC permissions and roles...");

  // 1. Seed Permissions
  for (const perm of PERMISSION_LIST) {
    await Permission.findOneAndUpdate(
      { name: perm.name },
      { $set: perm },
      { upsert: true, new: true }
    );
  }

  const allPerms = await Permission.find();
  const permMap = new Map(allPerms.map((p) => [p.name, p._id]));

  const getIds = (names: string[]) => names.map((n) => permMap.get(n)).filter(Boolean);

  // 2. Define Roles
  const roles = [
    {
      name: "super_admin",
      description: "Highest administrative authority",
      level: 5,
      isSystem: true,
      permissions: getIds(PERMISSION_LIST.map((p) => p.name)), // All permissions
    },
    {
      name: "operations",
      description: "Manage everyday GreenRev marketplace operations",
      level: 3,
      isSystem: true,
      permissions: getIds([
        "customer.view", "customer.suspend", "customer.restore",
        "vendor.view", "vendor.verify", "vendor.approve", "vendor.suspend",
        "mechanic.view", "mechanic.approve",
        "listing.view", "listing.approve", "listing.reject", "listing.suspend",
        "order.view", "order.manage",
        "transaction.view", "transaction.flag",
        "support.manage", "dispute.view", "dispute.resolve"
      ]),
    },
    {
      name: "customer_support",
      description: "Handle users, complaints, transaction enquiries and routine support",
      level: 2,
      isSystem: true,
      permissions: getIds([
        "customer.view", "vendor.view", "listing.view",
        "order.view", "transaction.view", "support.manage", "dispute.view", "dispute.manage"
      ]),
    },
    {
      name: "it_admin",
      description: "Manage technical administration and investigate platform issues",
      level: 3,
      isSystem: true,
      permissions: getIds([
        "config.view", "config.modify", "technical_logs.view"
      ]),
    },
  ];

  // 3. Seed Roles
  for (const roleData of roles) {
    await Role.findOneAndUpdate(
      { name: roleData.name },
      { $set: roleData },
      { upsert: true, new: true }
    );
  }

  // 4. Seed Super Admin (Optional)
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD;

  if (superAdminEmail && superAdminPassword) {
    const existingAdmin = await User.findOne({ email: superAdminEmail.toLowerCase() });
    if (!existingAdmin) {
      console.log("Seeding super admin...");
      const passwordHash = await hashPassword(superAdminPassword);
      const superAdminRole = await Role.findOne({ name: "super_admin" });

      await User.create({
        email: superAdminEmail.toLowerCase(),
        passwordHash,
        role: "admin",
        assignedRole: superAdminRole?._id,
        name: "Super Admin",
        isEmailVerified: true,
      });
      console.log("Super admin seeded successfully.");
    } else {
      console.log("Super admin already exists, updating role just in case...");
      const superAdminRole = await Role.findOne({ name: "super_admin" });
      existingAdmin.assignedRole = superAdminRole?._id;
      await existingAdmin.save();
    }
  }

  console.log("RBAC seeding complete!");
}

if (require.main === module) {
  require("dotenv").config();
  mongoose
    .connect((process.env.MONGO_URI || process.env.MONGODB_URI) as string)
    .then(async () => {
      await seedRbac();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
