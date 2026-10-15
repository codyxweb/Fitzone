const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

const defaults = [
  { name: "Monthly Starter", durationDays: 30, price: 1499, description: "A great way to get started.", active: true },
  { name: "Quarterly Strength", durationDays: 90, price: 3999, description: "Consistent training, better value.", active: true },
  { name: "Annual Transformation", durationDays: 365, price: 12999, description: "A full year of progress.", active: true },
];

async function migrateLocations() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  await mongoose.connect(uri);
  try {
    const db = mongoose.connection.db;
    const users = db.collection("users");
    const locations = db.collection("locations");
    const owner = await users.findOne({ role: "owner" });
    if (!owner) throw new Error("Create the owner account before running the location migration");
    let primary = await locations.findOne({ ownerId: owner._id }, { sort: { createdAt: 1 } });
    if (!primary) {
      const result = await locations.insertOne({ ownerId: owner._id, name: "FitZone Fitness Hub", address: "DEORIA, UTTAR PRADESH", active: true, createdAt: new Date(), updatedAt: new Date() });
      primary = await locations.findOne({ _id: result.insertedId });
    }
    const branchId = primary._id;
    const scopedCollections = ["attendance", "retentioncases", "payments", "products", "qrsessions", "plans"];
    for (const collectionName of scopedCollections) {
      const result = await db.collection(collectionName).updateMany(
        { $or: [{ branchId: { $exists: false } }, { branchId: null }] },
        { $set: { branchId } },
      );
      if (result.modifiedCount) console.log(`Assigned ${result.modifiedCount} existing ${collectionName} records to the primary location.`);
    }
    await users.updateMany({ role: { $ne: "owner" }, $or: [{ branchId: { $exists: false } }, { branchId: null }] }, { $set: { branchId } });
    const planCollection = db.collection("plans");
    const oldNameIndex = (await planCollection.indexes()).find((index) => index.name === "name_1" && index.unique);
    if (oldNameIndex) await planCollection.dropIndex("name_1");
    await planCollection.createIndex({ branchId: 1, name: 1 }, { unique: true });
    for (const plan of defaults) {
      await planCollection.updateOne({ branchId, name: plan.name }, { $set: { ...plan, branchId } }, { upsert: true });
    }
    console.log(`Location migration complete. Primary location: ${primary.name}.`);
  } finally {
    await mongoose.disconnect();
  }
}

migrateLocations().catch((error) => {
  console.error("Location migration failed:", error.message);
  process.exitCode = 1;
});
