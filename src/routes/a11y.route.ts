import { Router } from "express";
import {
  getA11yData,
  nearbyA11y,
  getBathroomData,
} from "../modules/a11y/a11y.controller";
import {
  a11yRouteRank,
  a11yRouteSelect,
  a11yAISuggestion,
} from "../modules/chatbot/chatbot.controller";
import { accessibleRoute } from "../modules/accessible-route/accessible-route.controller";

const route = Router();

route.get("/all-places", getA11yData);
route.get("/all-bathrooms", getBathroomData);
route.get("/nearby-a11y", nearbyA11y);
route.post("/route-rank", a11yRouteRank);
route.post("/route-select", a11yRouteSelect);
route.post("/chatbot", a11yAISuggestion);
route.post("/accessible-route", accessibleRoute);

export default route;
