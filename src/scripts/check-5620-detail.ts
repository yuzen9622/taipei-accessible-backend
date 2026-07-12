import mongoose from "mongoose";
import BusRouteModel from "../model/bus-route.model";

const uri = process.env.DATABASE_URL || "";

async function main() {
  if (!uri) {
    console.error("No DATABASE_URL found");
    return;
  }
  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const route = await BusRouteModel.findOne({ "routeName.Zh_tw": "5620" }).lean();
  console.log("5620 Route:", JSON.stringify(route, null, 2));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  mongoose.disconnect();
});
