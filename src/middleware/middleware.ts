import { type NextFunction, type Request, type Response } from "express";
import { sendResponse } from "../config/lib";
import { ResponseMessage } from "../types/code";
import { verifyAccessToken } from "../config/jwt";
const middleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  const validRoute = ["/login", "/token", "/refresh"];

  const verify = verifyAccessToken(token ?? "");

  if (validRoute.includes(req.path)) {
    next();
    return;
  }

  if (verify.expired) {
    return sendResponse(res, false, "error", 401, ResponseMessage.UNAUTHORIZED);
  }

  if (!verify.decoded) {
    console.log(req.path);
    return sendResponse(res, false, "error", 403, ResponseMessage.FORBIDDEN);
  }

  console.log(`${req.method} ${req.url}`);
  next();
};
export default middleware;
