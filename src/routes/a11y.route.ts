import { Router } from "express";
import { getA11yData, nearbyA11y } from "../controller/a11y.controller";
const route = Router();

route.get("/", getA11yData);
route.get("/nearby-a11y", nearbyA11y);
export default route;
