import { Request, Response } from "express";
import { ApiResponse } from "../../types/response";
import { ResponseCode, ResponseMessage } from "../../types/code";
import { sendResponse } from "../../config/lib";
import { IConfig, IUser } from "../../types";
import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../../config/jwt";
import * as userService from "./user.service";

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
    const { user, config } = await userService.findOrCreateUser({
      name,
      email,
      avatar,
      client_id,
    });

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      { user, config },
      accessToken,
      refreshToken
    );
  } catch (error) {
    console.error(error);
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, ResponseMessage.INTERNAL_ERROR);
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
      const { user, config } = await userService.getUserWithConfig(
        verify.decoded.user.client_id,
      );
      return sendResponse(
        res,
        true,
        "success",
        ResponseCode.OK,
        ResponseMessage.OK,
        { user: user!, config }
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

async function lineLinkCode(req: Request, res: Response<ApiResponse<{
  bindCode: string;
  bindCodeExpiresAt: Date;
  bindUrl: string;
}>>) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.FORBIDDEN,
        ResponseMessage.FORBIDDEN
      );
    }

    const payload = await userService.issueLineLinkCode(userId);
    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      payload
    );
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

async function updateConfig(req: Request, res: Response<ApiResponse<IConfig>>) {
  try {
    const { user_id, ...rest } = req.body;
    if (!user_id) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT
      );
    }
    const config = await userService.updateConfig(user_id, rest);

    if (!config) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT
      );
    }

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      config
    );
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

async function config(req: Request, res: Response) {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT
      );
    }
    const userConfig = await userService.getConfig(user_id);

    return sendResponse(
      res,
      true,
      "success",
      ResponseCode.OK,
      ResponseMessage.OK,
      userConfig
    );
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
      res.cookie("refreshToken", "", { maxAge: 0 });
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

async function logout(req: Request, res: Response) {
  try {
    res.cookie("refreshToken", "", { maxAge: 0 });
    return sendResponse(res, true, "success", ResponseCode.OK, "Logout successful");
  } catch (error) {
    return sendResponse(res, false, "error", ResponseCode.INTERNAL_ERROR, "Logout failed");
  }
}
export { login, token, refresh, info, lineLinkCode, config, updateConfig, logout };
