import express from "express";
import {
  login,
  token,
  refresh,
  info,
  config,
  updateConfig,
  logout,
} from "../modules/user/user.controller";

const route = express.Router();

route.post("/login", login);
route.post("/token", token);
route.get("/info", info);
route.post("/config", config);
route.post("/config/update", updateConfig);
route.post("/refresh", refresh);
route.post("/logout", logout);
export default route;
