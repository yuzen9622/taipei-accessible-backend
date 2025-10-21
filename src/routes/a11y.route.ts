import { Router } from "express";
import {
  getA11yData,
  nearbyA11y,
  getBathroomData,
  a11yRouteRank,
  a11yRouteSelect,
  a11yAISuggestion,
} from "../controller/a11y.controller";
const route = Router();

route.get("/all-places", getA11yData);
route.get("/all-bathrooms", getBathroomData);
route.get("/nearby-a11y", nearbyA11y);
route.post("/route-rank", a11yRouteRank);
route.post("/route-select", a11yRouteSelect);
route.post("/chatbot", a11yAISuggestion);
export default route;
