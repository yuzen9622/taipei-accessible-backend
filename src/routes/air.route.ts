import express from "express";
import { getAirQualityInfo } from "../modules/air/air.controller";
const route = express.Router();

route.get("/air-quality", getAirQualityInfo);
export default route;
