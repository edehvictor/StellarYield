import mongoose from "mongoose";

let connectionPromise: Promise<typeof mongoose> | null = null;

export async function connectToDatabase() {
  const connectionString = process.env.MONGODB_URI;

  if (!connectionString) {
    console.warn(
      "MONGODB_URI is not set. Historical yield snapshots will not be persisted.",
    );
    return null;
  }

  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(connectionString, {
      dbName: process.env.MONGODB_DB_NAME ?? "stellar_yield",
    });
  }

  try {
    return await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
}
