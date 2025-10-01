import express from "express";
import { login, token, refresh, info } from "../controller/user.controller";

const route = express.Router();

route.post("/login", login);
route.post("/token", token);
route.get("/info", info);
route.post("/refresh", refresh);
export default route;
