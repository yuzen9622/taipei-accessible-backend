import mongoose from "mongoose";

const uri = process.env.DATABASE_URL ?? "";

mongoose
  .connect(uri)
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });
