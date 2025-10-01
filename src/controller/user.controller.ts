import { Request, Response } from "express";
import { ApiResponse } from "../types/response";
import { ResponseCode, ResponseMessage } from "../types/code";
import { sendResponse } from "../config/lib";
import User from "../model/user.model";
import { IUser } from "../types";
import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../config/jwt";

async function login(
  req: Request,
  res: Response<ApiResponse<{ user: IUser }>>
) {
  try {
    const { name, email, avatar, client_id } = await req.body;
    if (!client_id || !email || !name) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT
      );
    }
    let user = await User.findOne({ client_id });
    if (!user) {
      user = new User({ name, email, avatar, client_id });
      await user.save();
    }

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);
    console.log(refreshToken);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user },
      accessToken,
      refreshToken
    );
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      status: "error",
      code: ResponseCode.INTERNAL_ERROR,
      message: ResponseMessage.INTERNAL_ERROR,
    });
  }
}

async function info(req: Request, res: Response<ApiResponse<{ user: IUser }>>) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) {
      throw new Error("No token provided");
    }
    const verify = verifyAccessToken(token);
    if (verify.decoded) {
      const user = await User.findOne({
        client_id: verify.decoded.user.client_id,
      });
      console.log(verify.decoded, verify.success);
      return sendResponse(
        res,
        true,
        "success",
        ResponseCode.OK,
        ResponseMessage.OK,
        { user: user! }
      );
    }
    throw new Error("Invalid token");
  } catch (error) {
    console.error(error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.INTERNAL_ERROR,
      ResponseMessage.INTERNAL_ERROR
    );
  }
}

async function token(
  req: Request,
  res: Response<ApiResponse<{ user: IUser }>>
) {
  try {
    const { token } = await req.body;

    const verify = verifyAccessToken(token);
    if (!verify.success || !verify?.decoded) {
      throw new Error("Invalid refresh token");
    }
    console.log(verify);
    const newAccessToken = createAccessToken(verify.decoded.user);
    const newRefreshToken = createRefreshToken(verify.decoded.user);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user: verify.decoded.user },
      newAccessToken,
      newRefreshToken
    );
  } catch (error) {
    console.log("no refresh token" + error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED
    );
  }
}

async function refresh(
  req: Request,
  res: Response<ApiResponse<{ user: IUser }>>
) {
  try {
    const { refreshToken } = await req.cookies;
    console.log(refreshToken);

    const verify = verifyRefreshToken(refreshToken);
    if (!verify.success || !verify.decoded) {
      throw new Error("Invalid refresh token");
    }
    console.log(verify);
    const newAccessToken = createAccessToken(verify.decoded.user);
    const newRefreshToken = createRefreshToken(verify.decoded.user);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user: verify.decoded.user },
      newAccessToken,
      newRefreshToken
    );
  } catch (error) {
    console.log("no refresh token" + error);
    return sendResponse(
      res,
      false,
      "error",
      ResponseCode.UNAUTHORIZED,
      ResponseMessage.UNAUTHORIZED
    );
  }
}
export { login, token, refresh, info };
