import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import "./config";
import { allowRoles, requireAuth, signToken, type AuthenticatedRequest } from "./auth";
import { Attendance, Location, LoginAttempt, MemberIssue, Payment, Plan, Product, RetentionCase, User } from "./models";
import { runRetentionScan } from "./retention";

const app = express();
let mongoConnection: Promise<typeof mongoose> | undefined;

async function ensureMongoConnection(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (mongoose.connection.readyState === 1) return;
  mongoConnection ??= mongoose.connect(uri).catch((error: unknown) => {
    mongoConnection = undefined;
    throw error;
  });
  await mongoConnection;
}

app.use((_req, _res, next) => {
  void ensureMongoConnection().then(() => next(), next);
});

const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const cookieSecure = process.env.NODE_ENV === "production";
const trustProxyHops = process.env.TRUST_PROXY_HOPS;
if (trustProxyHops !== undefined && trustProxyHops !== "") {
  const hopCount = Number(trustProxyHops);
  if (!Number.isInteger(hopCount) || hopCount < 1 || hopCount > 5) throw new Error("TRUST_PROXY_HOPS must be an integer from 1 to 5");
  app.set("trust proxy", hopCount);
}
if (process.env.NODE_ENV === "production" && !process.env.WEB_ORIGIN) {
  throw new Error("WEB_ORIGIN must be explicitly configured in production");
}
if (process.env.NODE_ENV === "production") {
  const configuredOrigin = new URL(webOrigin);
  if (configuredOrigin.protocol !== "https:" || configuredOrigin.origin !== webOrigin) {
    throw new Error("WEB_ORIGIN must be a bare HTTPS origin in production");
  }
}
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  if (cookieSecure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.get("origin") && req.get("origin") !== webOrigin) {
    res.status(403).json({ error: "Request origin is not allowed" });
    return;
  }
  next();
});

const loginSchema = z.object({
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(100),
});
const dummyPasswordHash = bcrypt.hash("invalid-account-lookup", 12);

async function countLoginAttempt(key: string, now: Date): Promise<number> {
  try {
    let attempt = await LoginAttempt.findOneAndUpdate(
      { key, expiresAt: { $gt: now } }, { $inc: { attempts: 1 } }, { new: true },
    );
    if (!attempt) {
      attempt = await LoginAttempt.findOneAndUpdate(
        { key },
        { $set: { attempts: 1, expiresAt: new Date(now.getTime() + 15 * 60 * 1000) } },
        { new: true, upsert: true },
      );
    }
    return (attempt as unknown as { attempts?: number } | null)?.attempts ?? 1;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    const attempt = await LoginAttempt.findOneAndUpdate({ key }, { $inc: { attempts: 1 } }, { new: true });
    return (attempt as unknown as { attempts?: number } | null)?.attempts ?? 1;
  }
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const ipKey = createHash("sha256").update(`ip\0${req.ip}`).digest("hex");
    const accountKey = createHash("sha256").update(`account\0${req.ip}\0${input.email}`).digest("hex");
    const now = new Date();
    const [currentIpRecord, currentAccountRecord] = await Promise.all([
      LoginAttempt.findOne({ key: ipKey, expiresAt: { $gt: now } }).lean(),
      LoginAttempt.findOne({ key: accountKey, expiresAt: { $gt: now } }).lean(),
    ]);
    const currentIpAttempts = (currentIpRecord as unknown as { attempts?: number } | null)?.attempts ?? 0;
    const currentAccountAttempts = (currentAccountRecord as unknown as { attempts?: number } | null)?.attempts ?? 0;
    if (currentIpAttempts >= 40 || currentAccountAttempts >= 8) {
      res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
      return;
    }
    const [ipAttempts, accountAttempts] = await Promise.all([
      countLoginAttempt(ipKey, now), countLoginAttempt(accountKey, now),
    ]);
    if (ipAttempts > 40 || accountAttempts > 8) {
      res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
      return;
    }
    const user = await User.findOne({ email: input.email }).select("+passwordHash +authVersion");
    const passwordHash = user?.passwordHash ?? await dummyPasswordHash;
    if (!(await bcrypt.compare(input.password, passwordHash)) || !user) {
      res.status(401).json({ error: "Email or password is incorrect" });
      return;
    }
    await LoginAttempt.deleteOne({ key: accountKey });
    res.cookie("fitzone_session", signToken({ id: user.id, role: user.role, authVersion: user.authVersion ?? 0 }), {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    });
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("fitzone_session", { httpOnly: true, secure: cookieSecure, sameSite: "lax", path: "/" });
  res.status(204).end();
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  newPassword: z.string().min(12).max(100),
});

app.patch("/api/auth/password", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = passwordChangeSchema.parse(req.body);
    const user = await User.findById(req.auth?.userId).select("+passwordHash +authVersion");
    if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      res.status(400).json({ error: "Current password is incorrect" });
      return;
    }
    user.passwordHash = await bcrypt.hash(input.newPassword, 12);
    user.authVersion = (user.authVersion ?? 0) + 1;
    await user.save();
    res.cookie("fitzone_session", signToken({ id: user.id, role: user.role, authVersion: user.authVersion }), {
      httpOnly: true, secure: cookieSecure, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000, path: "/",
    });
    res.json({ status: "updated" });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = await User.findById(req.auth?.userId).select("name email role membershipStatus membershipExpiresAt planName branchId");
    if (!user) {
      res.status(401).json({ error: "User account no longer exists" });
      return;
    }
    const location = user.branchId ? await Location.findById(user.branchId).select("name address") : null;
    res.json({ user, location });
  } catch (error) {
    next(error);
  }
});

const locationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().max(250).optional().default(""),
});

app.get("/api/locations", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    let locations = await Location.find({ ownerId: req.auth?.userId, active: true }).sort({ createdAt: 1 }).lean();
    if (!locations.length) {
      const location = await Location.create({ ownerId: req.auth?.userId, name: "FitZone Fitness Hub", address: "DEORIA, UTTAR PRADESH" });
      await Plan.insertMany([
        { branchId: location._id, name: "Monthly Starter", durationDays: 30, price: 1499, description: "A great way to get started.", active: true },
        { branchId: location._id, name: "Quarterly Strength", durationDays: 90, price: 3999, description: "Consistent training, better value.", active: true },
        { branchId: location._id, name: "Annual Transformation", durationDays: 365, price: 12999, description: "A full year of progress.", active: true },
      ]);
      locations = [location.toObject()];
    }
    res.json({ locations });
  } catch (error) {
    next(error);
  }
});

app.post("/api/locations", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = locationSchema.parse(req.body);
    const location = await Location.create({ ...input, ownerId: req.auth?.userId });
    const defaults = [
      { name: "Monthly Starter", durationDays: 30, price: 1499, description: "A great way to get started.", active: true },
      { name: "Quarterly Strength", durationDays: 90, price: 3999, description: "Consistent training, better value.", active: true },
      { name: "Annual Transformation", durationDays: 365, price: 12999, description: "A full year of progress.", active: true },
    ];
    await Plan.insertMany(defaults.map((plan) => ({ ...plan, branchId: location._id })));
    res.status(201).json({ location });
  } catch (error) {
    next(error);
  }
});

async function resolveLocation(req: AuthenticatedRequest & { locationId?: string }, res: express.Response, next: express.NextFunction) {
  try {
    const account = await User.findById(req.auth?.userId).select("role branchId");
    if (!account) {
      res.status(401).json({ error: "User account no longer exists" });
      return;
    }
    const requestedId = req.get("x-location-id");
    if (account.role === "owner" && requestedId && !/^[0-9a-fA-F]{24}$/.test(requestedId)) {
      res.status(400).json({ error: "Selected gym location is invalid" });
      return;
    }
    const location = account.role === "owner"
      ? await Location.findOne({
          ownerId: account._id,
          active: true,
          ...(requestedId ? { _id: requestedId } : {}),
        }).sort({ createdAt: 1 })
      : account.branchId
        ? await Location.findOne({ _id: account.branchId, active: true })
        : null;
    if (!location) {
      res.status(400).json({ error: "Choose an active gym location before loading its data" });
      return;
    }
    req.locationId = location.id;
    next();
  } catch (error) {
    next(error);
  }
}

app.use("/api", requireAuth, (req, res, next) => resolveLocation(req as AuthenticatedRequest & { locationId?: string }, res, next));

const dateDaysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function indiaReportRange(period: "day" | "week" | "month", dateValue?: string) {
  const date = dateValue ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw Object.assign(new Error("Date must use YYYY-MM-DD format"), { status: 400 });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = Date.UTC(year, month - 1, day);
  const parsed = new Date(calendarDate);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw Object.assign(new Error("Date is invalid"), { status: 400 });
  }
  const dayMs = 86_400_000;
  let startCalendar = calendarDate;
  let endCalendar = calendarDate + dayMs;
  if (period === "week") {
    startCalendar -= ((parsed.getUTCDay() + 6) % 7) * dayMs;
    endCalendar = startCalendar + 7 * dayMs;
  } else if (period === "month") {
    startCalendar = Date.UTC(year, month - 1, 1);
    endCalendar = Date.UTC(year, month, 1);
  }
  const indiaOffsetMs = 330 * 60_000;
  return { start: new Date(startCalendar - indiaOffsetMs), end: new Date(endCalendar - indiaOffsetMs) };
}

const newAccountSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  phone: z.string().trim().max(30).optional().default(""),
  role: z.enum(["member", "staff", "trainer"]),
  password: z.string().min(12).max(100),
});

app.get("/api/users", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const users = await User.find({ branchId: req.locationId, role: { $in: ["member", "staff", "trainer"] } })
      .select("name email phone role membershipStatus membershipExpiresAt planName joinedAt")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const input = newAccountSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await User.create({
      name: input.name,
      email: input.email,
      phone: input.phone,
      role: input.role,
      branchId: req.locationId,
      passwordHash,
    });
    res.status(201).json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } });
  } catch (error) {
    next(error);
  }
});

app.get("/api/dashboard", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [activeMembers, checkInsToday, openRetentionCases, revenue, activity, resolvedCases, totalCases, recentAttendance] =
      await Promise.all([
        User.countDocuments({ branchId: req.locationId, role: "member", membershipStatus: "active", membershipExpiresAt: { $gt: new Date() } }),
        Attendance.countDocuments({ branchId: req.locationId, checkedInAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
        RetentionCase.countDocuments({ branchId: req.locationId, status: "open" }),
        Payment.aggregate([{ $match: { branchId: new mongoose.Types.ObjectId(req.locationId), paidAt: { $gte: monthStart }, status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
        Attendance.distinct("userId", { branchId: req.locationId, checkedInAt: { $gte: dateDaysAgo(7) } }),
        RetentionCase.countDocuments({ branchId: req.locationId, status: "resolved", resolvedAt: { $gte: monthStart } }),
        RetentionCase.countDocuments({ branchId: req.locationId, openedAt: { $gte: monthStart } }),
        Attendance.find({ branchId: req.locationId }).sort({ checkedInAt: -1 }).limit(6).populate("userId", "name").lean(),
      ]);
    const eligibleMembers = await User.countDocuments({
      branchId: req.locationId,
      role: "member",
      membershipStatus: "active",
      membershipExpiresAt: { $gt: new Date() },
    });
    res.json({
      activeMembers,
      checkInsToday,
      openRetentionCases,
      revenueThisMonth: revenue[0]?.total ?? 0,
      activityRate7d: eligibleMembers ? Math.round((activity.length / eligibleMembers) * 100) : 0,
      recoveryRate: totalCases ? Math.round((resolvedCases / totalCases) * 100) : 0,
      renewalRate: 0,
      recentAttendance: recentAttendance.map((record) => ({
        memberName: (record.userId as { name?: string } | null)?.name ?? "Unknown member",
        checkedInAt: record.checkedInAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

const exportQuerySchema = z.object({
  period: z.enum(["day", "week", "month"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

app.get("/api/owner/exports/attendance", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const input = exportQuerySchema.parse(req.query);
    const range = indiaReportRange(input.period, input.date);
    const [location, records] = await Promise.all([
      Location.findById(req.locationId).select("name").lean(),
      Attendance.find({ branchId: req.locationId, checkedInAt: { $gte: range.start, $lt: range.end } })
        .populate("userId", "name email")
        .sort({ checkedInAt: 1 })
        .lean(),
    ]);
    res.json({
      locationName: (location as { name?: string } | null)?.name ?? "Gym",
      range,
      rows: records.map((record) => {
        const member = record.userId as { _id?: unknown; name?: string; email?: string } | null;
        return {
          attendanceId: String(record._id),
          memberId: member?._id ? String(member._id) : "",
          memberName: member?.name ?? "Unknown member",
          memberEmail: member?.email ?? "",
          checkedInAt: record.checkedInAt.toISOString(),
          source: record.source,
          assistedReason: record.assistedReason ?? "",
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/owner/exports/membership-payments", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const input = exportQuerySchema.parse(req.query);
    const range = indiaReportRange(input.period, input.date);
    const [location, records] = await Promise.all([
      Location.findById(req.locationId).select("name").lean(),
      Payment.find({ branchId: req.locationId, status: "paid", paidAt: { $gte: range.start, $lt: range.end } })
        .populate("userId", "name email")
        .populate("planId", "name durationDays")
        .sort({ paidAt: 1 })
        .lean(),
    ]);
    res.json({
      locationName: (location as { name?: string } | null)?.name ?? "Gym",
      range,
      rows: records.map((record) => {
        const member = record.userId as { _id?: unknown; name?: string; email?: string } | null;
        const plan = record.planId as { name?: string; durationDays?: number } | null;
        return {
          category: "Membership",
          paymentId: String(record._id),
          memberId: member?._id ? String(member._id) : "",
          memberName: member?.name ?? "Unknown member",
          memberEmail: member?.email ?? "",
          membershipPlan: plan?.name ?? "Membership",
          amountINR: record.amount,
          paidAt: record.paidAt?.toISOString() ?? "",
          receiptNumber: record.receiptNumber,
          razorpayOrderId: record.razorpayOrderId ?? "",
          razorpayTransactionId: record.razorpayPaymentId ?? "",
          status: record.status,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/owner/notifications", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const [unreadCount, issues] = await Promise.all([
      MemberIssue.countDocuments({ branchId: req.locationId, status: "unread" }),
      MemberIssue.find({ branchId: req.locationId })
        .populate("userId", "name email phone")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);
    res.json({
      unreadCount,
      issues: issues.map((issue) => ({
        _id: String(issue._id),
        message: issue.message,
        status: issue.status,
        createdAt: issue.createdAt,
        readAt: issue.readAt,
        member: issue.userId && typeof issue.userId === "object" && "name" in issue.userId
          ? { name: issue.userId.name, email: issue.userId.email, phone: issue.userId.phone }
          : { name: "Unknown member", email: "", phone: "" },
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/owner/notifications/:issueId/read", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const issueId = z.string().regex(/^[0-9a-fA-F]{24}$/).parse(req.params.issueId);
    const issue = await MemberIssue.findOneAndUpdate(
      { _id: issueId, branchId: req.locationId },
      { $set: { status: "read", readAt: new Date() } },
      { new: true },
    );
    if (!issue) {
      res.status(404).json({ error: "Member message not found" });
      return;
    }
    res.json({ issue });
  } catch (error) {
    next(error);
  }
});

app.get("/api/members", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const search = z.string().trim().max(100).optional().parse(req.query.search);
    const filter = {
      branchId: req.locationId,
      role: "member",
      ...(search ? { $or: [{ name: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { email: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }] } : {}),
    };
    const members = await User.find(filter)
      .select("name email phone membershipStatus membershipExpiresAt planName joinedAt")
      .sort({ name: 1 })
      .limit(100)
      .lean();
    res.json({ members });
  } catch (error) {
    next(error);
  }
});

app.get("/api/members/:memberId/profile", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const memberId = z.string().regex(/^[0-9a-fA-F]{24}$/).parse(req.params.memberId);
    const member = await User.findOne({ _id: memberId, branchId: req.locationId, role: "member" })
      .select("name email phone membershipStatus membershipExpiresAt planName joinedAt")
      .lean();
    if (!member) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    const [payments, checkIns] = await Promise.all([
      Payment.find({ userId: memberId, branchId: req.locationId, status: "paid" })
        .populate("planId", "name durationDays")
        .sort({ paidAt: -1 })
        .lean(),
      Attendance.countDocuments({ userId: memberId, branchId: req.locationId }),
    ]);
    const membershipMonths = payments.reduce((months, payment) => {
      const durationDays = (payment.planId as unknown as { durationDays?: number } | null)?.durationDays ?? 0;
      return months + durationDays / 30;
    }, 0);
    const membershipDays = Math.max(1, Math.ceil((Date.now() - new Date((member as unknown as { joinedAt: Date }).joinedAt).getTime()) / 86_400_000));
    res.json({
      member,
      stats: {
        membershipMonths: Math.round(membershipMonths * 10) / 10,
        totalPaid: payments.reduce((total, payment) => total + payment.amount, 0),
        paymentCount: payments.length,
        checkIns,
        strikeRate: Math.min(100, Math.round((checkIns / membershipDays) * 100)),
      },
      payments,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/trainer/members", requireAuth, allowRoles("trainer"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const members = await User.find({ branchId: req.locationId, role: "member", trainerId: req.auth?.userId })
      .select("name email phone membershipStatus membershipExpiresAt planName")
      .sort({ name: 1 })
      .limit(100)
      .lean();
    res.json({ members });
  } catch (error) {
    next(error);
  }
});

app.get("/api/retention", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const cases = await RetentionCase.find({ branchId: req.locationId, status: "open" })
      .populate("userId", "name email phone membershipStatus membershipExpiresAt planName")
      .sort({ absentDays: -1 })
      .lean();
    res.json({ cases });
  } catch (error) {
    next(error);
  }
});

app.post("/api/retention/scan", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    res.json(await runRetentionScan(req.locationId));
  } catch (error) {
    next(error);
  }
});

const outcomeSchema = z.object({
  outcome: z.enum(["will_return", "injured", "travelling", "timing_issue", "unhappy", "no_response", "cancelled"]),
  note: z.string().trim().max(1000).optional(),
  nextActionAt: z.coerce.date().optional(),
});

app.post("/api/retention/:caseId/follow-ups", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const input = outcomeSchema.parse(req.body);
    const retentionCase = await RetentionCase.findOneAndUpdate(
      { _id: req.params.caseId, branchId: req.locationId, status: "open" },
      { $push: { followUps: { ...input, recordedBy: new mongoose.Types.ObjectId(req.auth?.userId) } } },
      { new: true, runValidators: true },
    );
    if (!retentionCase) {
      res.status(404).json({ error: "Open retention case not found" });
      return;
    }
    if (input.outcome === "cancelled") {
      retentionCase.status = "resolved";
      retentionCase.resolvedAt = new Date();
      await retentionCase.save();
    }
    res.status(201).json({ case: retentionCase });
  } catch (error) {
    next(error);
  }
});

const checkinSchema = z.object({ locationId: z.string().regex(/^[0-9a-fA-F]{24}$/) });

function gymDayStart(now = new Date()): Date {
  const indiaTime = new Date(now.getTime() + 330 * 60_000);
  indiaTime.setUTCHours(0, 0, 0, 0);
  return new Date(indiaTime.getTime() - 330 * 60_000);
}

async function recordAttendance(branchId: string, userId: string, source: "qr" | "assisted", recordedBy?: string, assistedReason?: string) {
  const user = await User.findOne({
    _id: userId,
    branchId,
    role: "member",
    membershipStatus: "active",
    membershipExpiresAt: { $gt: new Date() },
  });
  if (!user) {
    const error = new Error("An active membership is required to check in");
    Object.assign(error, { status: 403 });
    throw error;
  }
  const dayStart = gymDayStart();
  const duplicate = await Attendance.findOne({ branchId, userId, checkedInAt: { $gte: dayStart } }).sort({ checkedInAt: -1 });
  if (duplicate) {
    const error = new Error("A check-in has already been recorded for today");
    Object.assign(error, { status: 409 });
    throw error;
  }
  const checkedInAt = new Date();
  const lock = await User.updateOne(
    { _id: user._id, $or: [{ lastCheckInAt: { $exists: false } }, { lastCheckInAt: { $lt: dayStart } }] },
    { $set: { lastCheckInAt: checkedInAt } },
  );
  if (!lock.modifiedCount) {
    const error = new Error("A check-in has already been recorded for today");
    Object.assign(error, { status: 409 });
    throw error;
  }
  let attendance;
  try {
    attendance = await Attendance.create({
      branchId, userId, source, checkedInAt,
      ...(recordedBy ? { recordedBy } : {}),
      ...(assistedReason ? { assistedReason } : {}),
    });
  } catch (error) {
    await User.updateOne({ _id: user._id, lastCheckInAt: checkedInAt }, { $unset: { lastCheckInAt: 1 } });
    throw error;
  }
  await RetentionCase.updateOne(
    { branchId, userId, status: "open" },
    { $set: { status: "resolved", resolvedAt: new Date() } },
  );
  return attendance;
}

app.post("/api/attendance/check-in", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = checkinSchema.parse(req.body);
    if (req.auth?.role !== "member") {
      res.status(403).json({ error: "Only a member can use the gym entry QR" });
      return;
    }
    if (input.locationId !== req.locationId) {
      res.status(403).json({ error: "This entry QR belongs to a different gym location" });
      return;
    }
    const attendance = await recordAttendance(req.locationId!, req.auth.userId, "qr");
    res.status(201).json({ attendance });
  } catch (error) {
    next(error);
  }
});

const assistedSchema = z.object({
  memberId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  reason: z.string().trim().min(5, "Please provide a meaningful assisted check-in reason").max(300),
});

app.post("/api/attendance/assisted", requireAuth, allowRoles("owner", "staff"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = assistedSchema.parse(req.body);
    const attendance = await recordAttendance(req.locationId!, input.memberId, "assisted", req.auth?.userId, input.reason);
    res.status(201).json({ attendance });
  } catch (error) {
    next(error);
  }
});

app.get("/api/plans", requireAuth, async (req, res, next) => {
  try {
    const plans = await Plan.find({ branchId: req.locationId, active: true }).sort({ durationDays: 1 }).lean();
    res.json({ plans });
  } catch (error) {
    next(error);
  }
});

const planInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  durationDays: z.number().int().min(1).max(3650),
  price: z.number().int().min(1),
  description: z.string().trim().max(500).optional().default(""),
  offer: z.string().trim().max(200).optional().default(""),
});

app.get("/api/owner/plans", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const plans = await Plan.find({ branchId: req.locationId }).sort({ active: -1, durationDays: 1 }).lean();
    res.json({ plans });
  } catch (error) {
    next(error);
  }
});

app.post("/api/owner/plans", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = planInputSchema.parse(req.body);
    const existing = await Plan.findOne({ branchId: req.locationId, name: input.name });
    if (existing?.active) {
      res.status(409).json({ error: "A plan with this name already exists at this location" });
      return;
    }
    const plan = existing
      ? await Plan.findByIdAndUpdate(existing._id, { ...input, active: true }, { new: true, runValidators: true })
      : await Plan.create({ ...input, branchId: req.locationId, active: true });
    res.status(201).json({ plan });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/owner/plans/:planId", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const planId = z.string().regex(/^[0-9a-fA-F]{24}$/).parse(req.params.planId);
    const input = planInputSchema.parse(req.body);
    const duplicate = await Plan.findOne({ branchId: req.locationId, name: input.name, _id: { $ne: planId } });
    if (duplicate) {
      res.status(409).json({ error: "A plan with this name already exists at this location" });
      return;
    }
    const plan = await Plan.findOneAndUpdate({ _id: planId, branchId: req.locationId, active: true }, input, { new: true, runValidators: true });
    if (!plan) {
      res.status(404).json({ error: "Active membership plan not found" });
      return;
    }
    res.json({ plan });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/owner/plans/:planId", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const planId = z.string().regex(/^[0-9a-fA-F]{24}$/).parse(req.params.planId);
    const plan = await Plan.findOneAndUpdate({ _id: planId, branchId: req.locationId, active: true }, { active: false }, { new: true });
    if (!plan) {
      res.status(404).json({ error: "Active membership plan not found" });
      return;
    }
    res.json({ plan });
  } catch (error) {
    next(error);
  }
});

app.get("/api/products", requireAuth, async (req, res, next) => {
  try {
    const products = await Product.find({ branchId: req.locationId, active: true }).sort({ createdAt: -1 }).lean();
    res.json({ products });
  } catch (error) {
    next(error);
  }
});

const productSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  price: z.number().min(0),
  imageUrl: z.string().trim().url().or(z.literal("")).optional(),
});

app.post("/api/products", requireAuth, allowRoles("owner"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = productSchema.parse(req.body);
    const product = await Product.create({ ...input, branchId: req.locationId, createdBy: req.auth?.userId });
    res.status(201).json({ product });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/products/:productId/archive", requireAuth, allowRoles("owner"), async (req, res, next) => {
  try {
    const productId = z.string().regex(/^[0-9a-fA-F]{24}$/).parse(req.params.productId);
    const product = await Product.findOneAndUpdate({ _id: productId, branchId: req.locationId }, { active: false }, { new: true });
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json({ product });
  } catch (error) {
    next(error);
  }
});

app.get("/api/member/dashboard", requireAuth, allowRoles("member"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.auth?.userId;
    const [member, payments, checkIns, recentAttendance, activeDays, location] = await Promise.all([
      User.findOne({ _id: userId, branchId: req.locationId }).select("name email phone membershipStatus membershipExpiresAt planName joinedAt").lean(),
      Payment.find({ branchId: req.locationId, userId, status: "paid" }).populate("planId", "name durationDays").sort({ paidAt: -1 }).lean(),
      Attendance.countDocuments({ branchId: req.locationId, userId }),
      Attendance.find({ branchId: req.locationId, userId }).sort({ checkedInAt: -1 }).limit(8).select("checkedInAt source").lean(),
      Attendance.aggregate([
        { $match: { branchId: new mongoose.Types.ObjectId(req.locationId), userId: new mongoose.Types.ObjectId(userId) } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$checkedInAt", timezone: "Asia/Kolkata" } } } },
      ]),
      Location.findById(req.locationId).select("name address").lean(),
    ]);
    if (!member) {
      res.status(404).json({ error: "Member account not found" });
      return;
    }
    const membershipDays = Math.max(1, Math.ceil((Date.now() - new Date((member as unknown as { joinedAt: Date }).joinedAt).getTime()) / 86_400_000));
    res.json({
      member,
      stats: {
        checkIns,
        strikeRate: Math.min(100, Math.round((activeDays.length / membershipDays) * 100)),
        totalPaid: payments.reduce((total, payment) => total + payment.amount, 0),
        paymentCount: payments.length,
        membershipMonths: Math.round(payments.reduce((months, payment) => {
          const durationDays = (payment.planId as unknown as { durationDays?: number } | null)?.durationDays ?? 0;
          return months + durationDays / 30;
        }, 0) * 10) / 10,
      },
      location,
      payments,
      recentAttendance,
    });
  } catch (error) {
    next(error);
  }
});

const memberIssueInputSchema = z.object({ message: z.string().trim().min(5).max(1500) });
app.post("/api/member/issues", requireAuth, allowRoles("member"), async (req: AuthenticatedRequest & { locationId?: string }, res, next) => {
  try {
    const input = memberIssueInputSchema.parse(req.body);
    const recentCount = await MemberIssue.countDocuments({
      branchId: req.locationId,
      userId: req.auth?.userId,
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    if (recentCount >= 5) {
      res.status(429).json({ error: "You have reached the daily message limit. Please try again later." });
      return;
    }
    const issue = await MemberIssue.create({ branchId: req.locationId, userId: req.auth?.userId, message: input.message });
    res.status(201).json({ issue: { id: issue.id, status: issue.status, createdAt: issue.createdAt } });
  } catch (error) {
    next(error);
  }
});

const renewalSchema = z.object({
  planId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  idempotencyKey: z.string().min(16).max(100),
});

const razorpayReady = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
app.get("/api/renewals/config", requireAuth, allowRoles("member"), (_req, res) => {
  res.json({ enabled: razorpayReady(), keyId: razorpayReady() ? process.env.RAZORPAY_KEY_ID : null });
});

async function createRazorpayOrder(amount: number, receipt: string) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw Object.assign(new Error("Online payments are not configured. Add Razorpay API keys to the API environment."), { status: 503 });
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: "INR", receipt }),
  });
  const data = await response.json() as { id?: string; error?: { description?: string } };
  if (!response.ok || !data.id) throw Object.assign(new Error(data.error?.description ?? "Could not start Razorpay checkout"), { status: 502 });
  return data.id;
}

async function isRazorpayPaymentCaptured(paymentId: string, orderId: string, amount: number) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return false;
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
  });
  if (!response.ok) return false;
  const payment = await response.json() as { order_id?: string; amount?: number; currency?: string; status?: string };
  return payment.order_id === orderId && payment.amount === Math.round(amount * 100) && payment.currency === "INR" && payment.status === "captured";
}

function validPaymentSignature(orderId: string, paymentId: string, signature: string) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

app.post("/api/renewals/checkout", requireAuth, allowRoles("member"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = renewalSchema.parse(req.body);
    if (!razorpayReady()) {
      res.status(503).json({ error: "Online payments are not configured. Add Razorpay API keys to the API environment." });
      return;
    }
    const orderLimitKey = createHash("sha256").update(`razorpay-order\0${req.auth?.userId}`).digest("hex");
    const orderLimit = await LoginAttempt.findOne({ key: orderLimitKey, expiresAt: { $gt: new Date() } }).lean() as unknown as { attempts?: number } | null;
    if ((orderLimit?.attempts ?? 0) >= 5 || (await countLoginAttempt(orderLimitKey, new Date())) > 5) {
      res.status(429).json({ error: "Too many checkout attempts. Please wait 15 minutes before trying again." });
      return;
    }
    const existing = await Payment.findOne({ branchId: req.locationId, idempotencyKey: input.idempotencyKey });
    if (existing) {
      if (existing.userId.toString() !== req.auth?.userId) {
        res.status(409).json({ error: "This checkout key belongs to another account" });
        return;
      }
      if (existing.status === "paid") {
        res.json({ payment: existing, duplicate: true });
        return;
      }
      if (existing.razorpayOrderId) {
        res.json({ orderId: existing.razorpayOrderId, amount: Math.round(existing.amount * 100), currency: "INR", keyId: process.env.RAZORPAY_KEY_ID, duplicate: true });
        return;
      }
      res.status(409).json({ error: "This checkout is still being prepared. Please try again." });
      return;
    }
    const plan = await Plan.findOne({ _id: input.planId, branchId: req.locationId, active: true });
    if (!plan) {
      res.status(404).json({ error: "Selected membership plan is not available" });
      return;
    }
    const user = await User.findOne({ _id: req.auth?.userId, branchId: req.locationId });
    if (!user) {
      res.status(404).json({ error: "Member account not found" });
      return;
    }
    const receiptNumber = `RCPT-${new Date().getFullYear()}-${randomBytes(3).toString("hex").toUpperCase()}`;
    let payment;
    try {
      payment = await Payment.create({
        branchId: req.locationId,
        userId: user._id,
        planId: plan._id,
        amount: plan.price,
        idempotencyKey: input.idempotencyKey,
        receiptNumber,
        status: "pending",
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 11000) {
        const concurrentPayment = await Payment.findOne({ branchId: req.locationId, idempotencyKey: input.idempotencyKey });
        if (concurrentPayment?.userId.toString() === req.auth?.userId) {
          if (concurrentPayment.razorpayOrderId) {
            res.json({ orderId: concurrentPayment.razorpayOrderId, amount: Math.round(concurrentPayment.amount * 100), currency: "INR", keyId: process.env.RAZORPAY_KEY_ID, duplicate: true });
            return;
          }
          res.status(409).json({ error: "This checkout is still being prepared. Please try again." });
          return;
        }
      }
      throw error;
    }
    try {
      const orderId = await createRazorpayOrder(plan.price, receiptNumber);
      payment.razorpayOrderId = orderId;
      await payment.save();
      res.status(201).json({ orderId, amount: Math.round(plan.price * 100), currency: "INR", keyId: process.env.RAZORPAY_KEY_ID });
    } catch (error) {
      await Payment.deleteOne({ _id: payment._id, status: "pending" });
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

const paymentVerifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().length(64),
});

app.post("/api/renewals/verify", requireAuth, allowRoles("member"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const input = paymentVerifySchema.parse(req.body);
    const payment = await Payment.findOne({ branchId: req.locationId, userId: req.auth?.userId, razorpayOrderId: input.razorpay_order_id });
    if (!payment) {
      res.status(404).json({ error: "Checkout order was not found" });
      return;
    }
    if (payment.status === "paid") {
      res.json({ payment, duplicate: true });
      return;
    }
    if (!validPaymentSignature(payment.razorpayOrderId!, input.razorpay_payment_id, input.razorpay_signature)) {
      res.status(400).json({ error: "Payment signature could not be verified" });
      return;
    }
    if (!(await isRazorpayPaymentCaptured(input.razorpay_payment_id, payment.razorpayOrderId!, payment.amount))) {
      res.status(402).json({ error: "Razorpay has not confirmed this payment as captured yet. Please contact gym staff if money was deducted." });
      return;
    }
    const plan = await Plan.findOne({ _id: payment.planId, branchId: req.locationId });
    const user = await User.findOne({ _id: req.auth?.userId, branchId: req.locationId });
    if (!plan || !user || payment.amount !== plan.price) {
      res.status(409).json({ error: "The membership plan changed. Contact gym staff before trying again." });
      return;
    }
    const confirmedPayment = await Payment.findOneAndUpdate(
      { _id: payment._id, status: "pending" },
      { $set: { razorpayPaymentId: input.razorpay_payment_id, status: "paid", paidAt: new Date() } },
      { new: true },
    );
    if (!confirmedPayment) {
      const alreadyPaid = await Payment.findById(payment._id);
      if (alreadyPaid?.status === "paid") {
        res.json({ payment: alreadyPaid, duplicate: true });
        return;
      }
      res.status(409).json({ error: "Payment state changed. Please refresh and check your receipt." });
      return;
    }
    const now = new Date();
    try {
      const membershipUpdate = await User.updateOne(
        { _id: user._id, branchId: req.locationId, role: "member" },
        [{ $set: {
          membershipStatus: "active",
          membershipExpiresAt: {
            $add: [
              { $cond: [
                { $and: [
                  { $eq: ["$membershipStatus", "active"] },
                  { $gt: [{ $ifNull: ["$membershipExpiresAt", now] }, now] },
                ] },
                "$membershipExpiresAt",
                now,
              ] },
              plan.durationDays * 24 * 60 * 60 * 1000,
            ],
          },
          planName: plan.name,
        } }],
      );
      if (!membershipUpdate.matchedCount) throw new Error("Member account was not found while applying the renewal");
    } catch (error) {
      await Payment.updateOne(
        { _id: confirmedPayment._id, status: "paid" },
        { $set: { status: "pending" }, $unset: { razorpayPaymentId: 1, paidAt: 1 } },
      );
      throw error;
    }
    res.status(201).json({ payment: confirmedPayment, duplicate: false });
  } catch (error) {
    next(error);
  }
});

app.get("/api/renewals/receipts", requireAuth, allowRoles("member"), async (req: AuthenticatedRequest, res, next) => {
  try {
    const payments = await Payment.find({ branchId: req.locationId, userId: req.auth?.userId, status: "paid" }).populate("planId", "name durationDays").sort({ paidAt: -1 }).lean();
    res.json({ payments });
  } catch (error) {
    next(error);
  }
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: error.flatten() });
    return;
  }
  if (error && typeof error === "object" && "code" in error && error.code === 11000) {
    res.status(409).json({ error: "A record with these details already exists" });
    return;
  }
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    res.status(error.status).json({ error: error.message ?? "Request failed" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "An unexpected server error occurred" });
};
app.use(errorHandler);

export default app;
