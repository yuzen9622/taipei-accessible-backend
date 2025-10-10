import { Router } from "express";
import { getBusData } from "../controller/transit.controller";
const route = Router();

route.get("/bus", getBusData);
export default route;
