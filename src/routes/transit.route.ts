import { Router } from "express";
import {
  getBusData,
  getRealtimeBusPosition,
} from "../modules/transit/transit.controller";
const route = Router();

route.post("/bus", getBusData);
route.get("/bus/realtime", getRealtimeBusPosition);
export default route;
