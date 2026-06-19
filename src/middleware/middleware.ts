import { type NextFunction, type Request, type Response } from "express";
import { sendResponse } from "../config/lib";
import { ResponseCode, ResponseMessage } from "../types/code";
import { verifyAccessToken } from "../config/jwt";
import type { IUser } from "../types";
const middleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  const validRoute = ["/login", "/token", "/refresh", "/logout"];

  const verify = verifyAccessToken(token ?? "");

  if (validRoute.includes(req.path)) {
    next();
    return;
  }

  if (verify.expired) {
    console.log("Token expired", verify, token);
    return sendResponse(res, false, "error", ResponseCode.UNAUTHORIZED, ResponseMessage.UNAUTHORIZED);
  }

  if (!verify.decoded) {
    console.log(req.path);
    return sendResponse(res, false, "error", ResponseCode.FORBIDDEN, ResponseMessage.FORBIDDEN);
  }

  const user = verify.decoded.user as IUser;
  req.auth = { userId: String(user?._id ?? ""), user };

  console.log(`${req.method} ${req.url}`);
  next();
};
export default middleware;
