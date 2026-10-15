import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import app from "./app";
import { Attendance, Location, Payment, Plan, RetentionCase, User } from "./models";
import { runRetentionScan } from "./retention";

let mongo: MongoMemoryServer;
let ownerCookie: string;
let memberCookie: string;
let memberId: string;
let secondMemberId: string;
let branchId: string;

beforeAll(async () => {
  process.env.JWT_SECRET = "fitzone-test-secret-with-enough-entropy";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.init(), Location.init(), Attendance.init(), RetentionCase.init(), Plan.init(), Payment.init()]);
  const passwordHash = await bcrypt.hash("Demo@1234", 4);
  const owner = await User.create({ name: "Test Owner", email: "owner@test.in", passwordHash, role: "owner" });
  const branch = await Location.create({ ownerId: owner._id, name: "Test FitZone", address: "Test City" });
  branchId = branch.id;
  await User.create([
    { name: "Test Trainer", email: "trainer@test.in", passwordHash, role: "trainer", branchId },
    {
      name: "Test Member",
      email: "member@test.in",
      passwordHash,
      role: "member",
      branchId,
      membershipStatus: "active",
      membershipExpiresAt: new Date(Date.now() + 60 * 86_400_000),
      joinedAt: new Date(Date.now() - 30 * 86_400_000),
    },
    {
      name: "Second Member",
      email: "second@test.in",
      passwordHash,
      role: "member",
      branchId,
      membershipStatus: "active",
      membershipExpiresAt: new Date(Date.now() + 60 * 86_400_000),
      joinedAt: new Date(Date.now() - 5 * 86_400_000),
    },
    {
      name: "Expired Member",
      email: "expired@test.in",
      passwordHash,
      role: "member",
      branchId,
      membershipStatus: "active",
      membershipExpiresAt: new Date(Date.now() - 86_400_000),
      joinedAt: new Date(Date.now() - 30 * 86_400_000),
    },
  ]);
  memberId = (await User.findOne({ email: "member@test.in" }))!.id;
  secondMemberId = (await User.findOne({ email: "second@test.in" }))!.id;
  const trainerId = (await User.findOne({ email: "trainer@test.in" }))!._id;
  await User.updateMany({ role: "member" }, { $set: { trainerId } });
  ownerCookie = (await request(app).post("/api/auth/login").send({ email: "owner@test.in", password: "Demo@1234" })).headers["set-cookie"][0].split(";")[0];
  memberCookie = (await request(app).post("/api/auth/login").send({ email: "member@test.in", password: "Demo@1234" })).headers["set-cookie"][0].split(";")[0];
}, 60_000);

afterEach(async () => {
  await Promise.all([
    Attendance.deleteMany({}),
    RetentionCase.deleteMany({}),
    Payment.deleteMany({}),
    Plan.deleteMany({}),
  ]);
  await User.updateMany(
    { role: "member", email: { $ne: "expired@test.in" } },
    { $set: { membershipStatus: "active", membershipExpiresAt: new Date(Date.now() + 60 * 86_400_000) } },
  );
  await User.updateOne(
    { email: "expired@test.in" },
    { $set: { membershipStatus: "active", membershipExpiresAt: new Date(Date.now() - 86_400_000) } },
  );
  await User.updateMany({ role: "member" }, { $unset: { lastCheckInAt: 1 } });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("authentication and attendance", () => {
  it("rejects an incorrect password", async () => {
    await request(app).post("/api/auth/login").send({ email: "owner@test.in", password: "wrong" }).expect(401);
  });

  it("allows each active member to use the permanent gym QR once per India gym day and resolves return cases", async () => {
    await RetentionCase.create({ branchId, userId: memberId, status: "open", absentDays: 12, priority: "low" });
    const body = { locationId: branchId };
    await request(app).post("/api/attendance/check-in").set("Cookie", memberCookie).send(body).expect(201);
    await request(app).post("/api/attendance/check-in").set("Cookie", memberCookie).send(body).expect(409);
    const secondCookie = (await request(app).post("/api/auth/login").send({ email: "second@test.in", password: "Demo@1234" })).headers["set-cookie"][0].split(";")[0];
    await request(app).post("/api/attendance/check-in").set("Cookie", secondCookie).send(body).expect(201);
    const retentionCase = await RetentionCase.findOne({ userId: memberId });
    expect(retentionCase?.status).toBe("resolved");
  });

  it("rejects permanent entry attempts without member authentication or for a different gym", async () => {
    await request(app).post("/api/attendance/check-in").send({ locationId: branchId }).expect(401);
    await request(app).post("/api/attendance/check-in").set("Cookie", memberCookie).send({ locationId: new mongoose.Types.ObjectId().toString() }).expect(403);
  });

  it("requires a valid reason for assisted check-in", async () => {
    await request(app)
      .post("/api/attendance/assisted")
      .set("Cookie", ownerCookie)
      .send({ memberId, reason: "   " })
      .expect(400);
  });

  it("limits trainer member access to assigned members", async () => {
    const trainerCookie = (await request(app).post("/api/auth/login").send({ email: "trainer@test.in", password: "Demo@1234" })).headers["set-cookie"][0].split(";")[0];
    const response = await request(app).get("/api/trainer/members").set("Cookie", trainerCookie).expect(200);
    expect(response.body.members).toHaveLength(3);
    expect(response.body.members.map((member: { _id: string }) => member._id)).toContain(memberId);
    await request(app).get("/api/members").set("Cookie", trainerCookie).expect(403);
  });
});

describe("retention and renewal", () => {
  it("opens a no-show case for an eligible member with no attendance history", async () => {
    const result = await runRetentionScan(branchId);
    expect(result.scanned).toBe(2);
    expect(result.opened).toBe(1);
    expect(await RetentionCase.exists({ userId: memberId, status: "open" })).toBeTruthy();
  });

  it("returns the same receipt and does not extend a membership twice for a repeated key", async () => {
    const plan = await Plan.create({ branchId, name: "Test month", durationDays: 30, price: 1000 });
    const before = (await User.findById(memberId))!.membershipExpiresAt!.getTime();
    const payload = { planId: plan.id, idempotencyKey: "same-key-for-repeat-test" };
    const first = await request(app).post("/api/renewals/checkout").set("Cookie", memberCookie).send(payload).expect(201);
    const second = await request(app).post("/api/renewals/checkout").set("Cookie", memberCookie).send(payload).expect(200);
    const after = (await User.findById(memberId))!.membershipExpiresAt!.getTime();
    expect(first.body.payment.receiptNumber).toBe(second.body.payment.receiptNumber);
    expect(second.body.duplicate).toBe(true);
    expect(after).toBe(before + 30 * 86_400_000);
  });
});
