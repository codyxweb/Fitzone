import mongoose, { Schema } from "mongoose";
import type { FollowUpOutcome, UserRole } from "@fitzone/shared";

const userSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    passwordHash: { type: String, required: true, select: false },
    authVersion: { type: Number, default: 0, select: false },
    role: { type: String, enum: ["owner", "staff", "trainer", "member"] satisfies UserRole[], required: true },
    membershipStatus: {
      type: String,
      enum: ["active", "paused", "frozen", "expired", "cancelled"],
      default: "expired",
    },
    membershipExpiresAt: { type: Date },
    lastCheckInAt: { type: Date, select: false },
    planName: { type: String, default: "No active plan" },
    trainerId: { type: Schema.Types.ObjectId, ref: "User" },
    joinedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
userSchema.index({ role: 1, membershipStatus: 1, membershipExpiresAt: 1 });
userSchema.index({ trainerId: 1, role: 1 });

const attendanceSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    checkedInAt: { type: Date, required: true, default: Date.now, index: true },
    source: { type: String, enum: ["qr", "assisted"], required: true },
    assistedReason: { type: String, trim: true },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);
attendanceSchema.index({ userId: 1, checkedInAt: -1 });

const followUpSchema = new Schema(
  {
    outcome: {
      type: String,
      enum: ["will_return", "injured", "travelling", "timing_issue", "unhappy", "no_response", "cancelled"],
      required: true,
    },
    note: { type: String, trim: true, default: "" },
    nextActionAt: { type: Date },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const retentionCaseSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["open", "resolved"], default: "open", index: true },
    absentDays: { type: Number, required: true, min: 0 },
    priority: { type: String, enum: ["high", "medium", "low"], required: true },
    openedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    followUps: { type: [followUpSchema], default: [] },
  },
  { timestamps: true },
);
retentionCaseSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: "open" } });
retentionCaseSchema.index({ status: 1, priority: 1, absentDays: -1 });

const planSchema = new Schema({
  branchId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
  name: { type: String, required: true },
  durationDays: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  description: { type: String, default: "" },
  offer: { type: String, trim: true, default: "", maxlength: 200 },
  active: { type: Boolean, default: true },
});
planSchema.index({ branchId: 1, name: 1 }, { unique: true });
planSchema.index({ branchId: 1, active: 1, durationDays: 1 });

const productSchema = new Schema({
  branchId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, trim: true, default: "", maxlength: 500 },
  price: { type: Number, required: true, min: 0 },
  imageUrl: { type: String, trim: true, default: "" },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
productSchema.index({ active: 1, createdAt: -1 });

const paymentSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Location", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
    amount: { type: Number, required: true, min: 0 },
    idempotencyKey: { type: String, required: true, unique: true },
    receiptNumber: { type: String, required: true, unique: true },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    razorpayPaymentId: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ["pending", "paid", "failed"], default: "pending", index: true },
    paidAt: { type: Date },
  },
  { timestamps: true },
);

const loginAttemptSchema = new Schema({
  key: { type: String, required: true, unique: true },
  attempts: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });

const memberIssueSchema = new Schema({
  branchId: { type: Schema.Types.ObjectId, ref: "Location", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  message: { type: String, required: true, trim: true, maxlength: 1500 },
  status: { type: String, enum: ["unread", "read"], default: "unread", index: true },
  readAt: { type: Date },
}, { timestamps: true });
memberIssueSchema.index({ branchId: 1, status: 1, createdAt: -1 });

export const User = mongoose.models.User ?? mongoose.model("User", userSchema);
const locationSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  address: { type: String, trim: true, maxlength: 250, default: "" },
  active: { type: Boolean, default: true },
}, { timestamps: true });
locationSchema.index({ ownerId: 1, name: 1 }, { unique: true });

export const Location = mongoose.models.Location ?? mongoose.model("Location", locationSchema);
export const Attendance = mongoose.models.Attendance ?? mongoose.model("Attendance", attendanceSchema);
export const RetentionCase = mongoose.models.RetentionCase ?? mongoose.model("RetentionCase", retentionCaseSchema);
export const Plan = mongoose.models.Plan ?? mongoose.model("Plan", planSchema);
export const Product = mongoose.models.Product ?? mongoose.model("Product", productSchema);
export const Payment = mongoose.models.Payment ?? mongoose.model("Payment", paymentSchema);
export const LoginAttempt = mongoose.models.LoginAttempt ?? mongoose.model("LoginAttempt", loginAttemptSchema);
export const MemberIssue = mongoose.models.MemberIssue ?? mongoose.model("MemberIssue", memberIssueSchema);

export type FollowUpRecord = {
  outcome: FollowUpOutcome;
  note?: string;
  nextActionAt?: Date;
  recordedBy: mongoose.Types.ObjectId;
};
