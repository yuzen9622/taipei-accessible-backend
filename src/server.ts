import app from "./app";
import mongoose from "mongoose";
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
const uri = process.env.DATABASE_URL ?? "";

mongoose
  .connect(uri)
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });

process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  server.close(() => {
    console.log("Process terminated");
  });
});

process.on("SIGINT", () => {
  console.log("\nSIGINT received");
  server.close(() => {
    console.log("Process terminated");
  });
});

export default server;
