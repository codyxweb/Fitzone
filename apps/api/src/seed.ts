import "./config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { Attendance, Location, Payment, Plan, RetentionCase, User } from "./models";
import { runRetentionScan } from "./retention";

async function seed(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Demo seed accounts are disabled in production");
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  await mongoose.connect(uri);
  if (process.argv.includes("--reset")) {
    const demoUserIds = await User.distinct("_id", { email: /@fitzone\.in$/i });
    const locationIds = await Location.distinct("_id", { ownerId: { $in: demoUserIds } });
    await Promise.all([
      Attendance.deleteMany({ userId: { $in: demoUserIds } }),
      Payment.deleteMany({ userId: { $in: demoUserIds } }),
      RetentionCase.deleteMany({ userId: { $in: demoUserIds } }),
      User.deleteMany({ email: /@fitzone\.in$/i }),
      Location.deleteMany({ ownerId: { $in: demoUserIds } }),
      Plan.deleteMany({ name: { $in: ["Monthly Starter", "Quarterly Strength", "Annual Transformation"] }, $or: [{ branchId: { $in: locationIds } }, { branchId: { $exists: false } }] }),
    ]);
  }
  const passwordHash = await bcrypt.hash("Demo@1234", 12);
  await User.updateOne({ email: "owner@fitzone.in" }, { $setOnInsert: { name: "Aarav Mehta", email: "owner@fitzone.in", phone: "9876500001", role: "owner", passwordHash } }, { upsert: true });
  const owner = await User.findOne({ email: "owner@fitzone.in" }).select("_id");
  if (!owner) throw new Error("Could not create the demo owner account");
  let location = await Location.findOne({ ownerId: owner._id }).sort({ createdAt: 1 });
  if (!location) location = await Location.create({ ownerId: owner._id, name: "FitZone Fitness Hub", address: "DEORIA, UTTAR PRADESH" });
  const accounts = [
    { name: "Priya Sharma", email: "staff@fitzone.in", phone: "9876500002", role: "staff", branchId: location._id },
    { name: "Rohan Verma", email: "trainer1@fitzone.in", phone: "9876500003", role: "trainer", branchId: location._id },
    { name: "Ananya Singh", email: "member1@fitzone.in", phone: "9876500004", role: "member", branchId: location._id, membershipStatus: "active", membershipExpiresAt: new Date(Date.now() + 45 * 86_400_000), planName: "Quarterly Strength" },
  ];
  for (const account of accounts) {
    await User.updateOne({ email: account.email }, { $setOnInsert: { ...account, passwordHash } }, { upsert: true });
  }
  const trainer = await User.findOne({ email: "trainer1@fitzone.in", role: "trainer", branchId: location._id }).select("_id");
  await Plan.bulkWrite([
    { updateOne: { filter: { branchId: location._id, name: "Monthly Starter" }, update: { $set: { branchId: location._id, durationDays: 30, price: 1499, description: "A great way to get started.", active: true } }, upsert: true } },
    { updateOne: { filter: { branchId: location._id, name: "Quarterly Strength" }, update: { $set: { branchId: location._id, durationDays: 90, price: 3999, description: "Consistent training, better value.", active: true } }, upsert: true } },
    { updateOne: { filter: { branchId: location._id, name: "Annual Transformation" }, update: { $set: { branchId: location._id, durationDays: 365, price: 12999, description: "A full year of progress.", active: true } }, upsert: true } },
  ]);
  const members = await User.find({ role: "member", branchId: location._id }).limit(30);
  if (members.length < 30) {
    const inserts = Array.from({ length: 30 - members.length }, (_, index) => {
      const sequence = members.length + index + 2;
      const inactive = sequence % 5 === 0;
      const daysAgo = inactive ? 10 + (sequence % 11) : Math.floor(Math.random() * 7);
      return {
        name: ["Kabir", "Meera", "Ishaan", "Tara", "Aditya", "Sana", "Vihaan", "Riya"][sequence % 8] + ` ${["Kapoor", "Gupta", "Rao", "Malhotra"][sequence % 4]}`,
        email: `member${sequence}@fitzone.in`,
        phone: `98765${String(10000 + sequence).slice(-5)}`,
        passwordHash,
        role: "member",
        branchId: location._id,
        membershipStatus: "active",
        membershipExpiresAt: new Date(Date.now() + (sequence % 5 === 0 ? 7 : 30 + sequence) * 86_400_000),
        planName: sequence % 2 ? "Monthly Starter" : "Quarterly Strength",
        ...(trainer ? { trainerId: trainer._id } : {}),
        joinedAt: new Date(Date.now() - (90 + sequence) * 86_400_000),
        _attendanceDaysAgo: daysAgo,
      };
    });
    for (const { _attendanceDaysAgo, ...member } of inserts) {
      const created = await User.create(member);
      await Attendance.create({
        branchId: location._id,
        userId: created._id,
        source: "qr",
        checkedInAt: new Date(Date.now() - _attendanceDaysAgo * 86_400_000),
      });
    }
  }
  const memberUser = await User.findOne({ email: "member1@fitzone.in", branchId: location._id });
  if (trainer) {
    await User.updateMany({ role: "member", branchId: location._id, trainerId: { $exists: false } }, { $set: { trainerId: trainer._id } });
  }
  if (memberUser && !(await Attendance.exists({ userId: memberUser._id }))) {
    await Attendance.create({ branchId: location._id, userId: memberUser._id, source: "qr", checkedInAt: new Date(Date.now() - 86_400_000) });
  }
  await runRetentionScan(location.id);
  console.log(`Seeded FitZone demo accounts. Login password for all demo accounts: Demo@1234`);
  await mongoose.disconnect();
}

void seed().catch(async (error: unknown) => {
  console.error("FitZone seed failed", error);
  await mongoose.disconnect();
  process.exitCode = 1;
});
