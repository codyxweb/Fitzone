import "./config";
import mongoose from "mongoose";
import cron from "node-cron";
import app from "./app";
import { Attendance, Location, LoginAttempt, MemberIssue, Payment, Plan, Product, RetentionCase, User } from "./models";
import { runRetentionScan } from "./retention";

const port = Number(process.env.PORT ?? 5000);

async function start(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters");
  }
  await mongoose.connect(uri);
  await Promise.all([LoginAttempt.init(), MemberIssue.init()]);
  const owners = await User.find({ role: "owner" }).select("_id").lean();
  for (const owner of owners) {
    let location = await Location.findOne({ ownerId: owner._id }).sort({ createdAt: 1 });
    if (!location) {
      location = await Location.create({ ownerId: owner._id, name: "FitZone Fitness Hub", address: "DEORIA, UTTAR PRADESH" });
    }
    const branchId = location._id;
    await User.updateMany({ role: { $ne: "owner" }, $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } });
    await Promise.all([
      Attendance.updateMany({ $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } }),
      RetentionCase.updateMany({ $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } }),
      Payment.updateMany({ $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } }),
      Product.updateMany({ $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } }),
      Plan.updateMany({ $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } }),
    ]);
    const indexes = await Plan.collection.indexes();
    const oldGlobalUniqueNameIndex = indexes.find((index) => index.name === "name_1" && index.unique);
    if (oldGlobalUniqueNameIndex) await Plan.collection.dropIndex("name_1");
    const defaults = [
      { name: "Monthly Starter", durationDays: 30, price: 1499, description: "A great way to get started." },
      { name: "Quarterly Strength", durationDays: 90, price: 3999, description: "Consistent training, better value." },
      { name: "Annual Transformation", durationDays: 365, price: 12999, description: "A full year of progress." },
    ];
    for (const plan of defaults) {
      await Plan.updateOne({ branchId, name: plan.name }, { $set: { ...plan, branchId, active: true } }, { upsert: true });
    }
  }
  app.listen(port, () => console.log(`FitZone API listening on port ${port}`));
  cron.schedule("0 6 * * *", () => {
    void Location.find({ active: true }).then((locations) => Promise.all(locations.map((location) => runRetentionScan(location.id))))
      .catch((error: unknown) => console.error("Daily retention scan failed", error));
  }, { timezone: "Asia/Kolkata" });
}

if (require.main === module) {
  void start().catch((error: unknown) => {
    console.error("Unable to start FitZone API", error);
    process.exitCode = 1;
  });
}
