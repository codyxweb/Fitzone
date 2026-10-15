import mongoose from "mongoose";
import { Attendance, RetentionCase, User } from "./models";

export async function runRetentionScan(branchId?: string): Promise<{ scanned: number; opened: number }> {
  const thresholdDays = Number(process.env.INACTIVITY_THRESHOLD_DAYS ?? 10);
  if (!Number.isInteger(thresholdDays) || thresholdDays < 1) {
    throw new Error("INACTIVITY_THRESHOLD_DAYS must be a positive integer");
  }
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
  const eligible = await User.find({
    ...(branchId ? { branchId } : {}),
    role: "member",
    membershipStatus: "active",
    membershipExpiresAt: { $gt: new Date() },
  }).select("_id joinedAt");
  const eligibleIds = eligible.map((member) => member._id);
  const latestAttendance = await Attendance.aggregate([
    { $match: { ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}), userId: { $in: eligibleIds } } },
    { $group: { _id: "$userId", lastAttendanceAt: { $max: "$checkedInAt" } } },
  ]);
  const latestMap = new Map(
    latestAttendance.map((item: { _id: { toString(): string }; lastAttendanceAt: Date }) => [
      item._id.toString(),
      item.lastAttendanceAt,
    ]),
  );
  let opened = 0;
  for (const member of eligible) {
    const lastAttendanceAt = latestMap.get(member._id.toString());
    const baseline = lastAttendanceAt ?? member.joinedAt;
    const absentDays = Math.floor((Date.now() - baseline.getTime()) / 86_400_000);
    if (baseline >= cutoff) continue;
    const existing = await RetentionCase.findOne({ ...(branchId ? { branchId } : {}), userId: member._id, status: "open" });
    const priority = absentDays >= 20 ? "high" : absentDays >= 14 ? "medium" : "low";
    if (existing) {
      existing.absentDays = absentDays;
      existing.priority = priority;
      await existing.save();
      continue;
    }
    await RetentionCase.create({ ...(branchId ? { branchId } : {}), userId: member._id, absentDays, priority });
    opened += 1;
  }
  return { scanned: eligible.length, opened };
}
