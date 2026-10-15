const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

async function resetToOwner() {
  if (process.env.NODE_ENV === "production") throw new Error("Owner reset is disabled in production");
  if (process.env.CONFIRM_RESET_OWNER !== "YES") throw new Error("Set CONFIRM_RESET_OWNER=YES to confirm the destructive database reset");
  const uri = process.env.MONGODB_URI;
  const password = process.env.OWNER_PASSWORD;
  const email = "owner@fitzone.in";
  if (!uri) throw new Error("MONGODB_URI is required");
  if (!password || password.length < 12) throw new Error("Set OWNER_PASSWORD (at least 12 characters) in the environment");

  const databasePath = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/i)?.[1] ?? "";
  const databaseName = databasePath || "test";
  if (!["gym-retention", "test"].includes(databaseName)) {
    throw new Error(`Refusing to reset unexpected database: ${databaseName || "(default)"}`);
  }

  await mongoose.connect(uri);
  try {
    console.log(`Dropping all data in database "${databaseName}"...`);
    await mongoose.connection.dropDatabase();
    const passwordHash = await bcrypt.hash(password, 12);
    const ownerResult = await mongoose.connection.collection("users").insertOne({
      name: "FitZone Owner",
      email,
      phone: "",
      passwordHash,
      role: "owner",
      membershipStatus: "expired",
      planName: "No active plan",
      joinedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mongoose.connection.collection("users").createIndex({ email: 1 }, { unique: true });
    const locationResult = await mongoose.connection.collection("locations").insertOne({
      ownerId: ownerResult.insertedId,
      name: "FitZone Fitness Hub",
      address: "DEORIA, UTTAR PRADESH",
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mongoose.connection.collection("plans").insertMany([
      { branchId: locationResult.insertedId, name: "Monthly Starter", durationDays: 30, price: 1499, description: "A great way to get started.", active: true },
      { branchId: locationResult.insertedId, name: "Quarterly Strength", durationDays: 90, price: 3999, description: "Consistent training, better value.", active: true },
      { branchId: locationResult.insertedId, name: "Annual Transformation", durationDays: 365, price: 12999, description: "A full year of progress.", active: true },
    ]);
    console.log(`Database recreated with the owner account ${email}.`);
  } finally {
    await mongoose.disconnect();
  }
}

resetToOwner().catch((error) => {
  console.error("Owner database reset failed:", error);
  process.exitCode = 1;
});
