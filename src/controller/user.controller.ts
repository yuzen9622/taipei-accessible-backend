import { Request, Response } from "express";
import { ApiResponse } from "../types/response";
import { ResponseCode, ResponseMessage } from "../types/code";
import { sendResponse } from "../config/lib";
import User from "../model/user.model";
import { IConfig, IUser } from "../types";
import {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../config/jwt";
import Config from "../model/config.model";

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
    let config = await Config.findOne({ user_id: user?._id });
    if (!user) {
      user = new User({ name, email, avatar, client_id });
      config = new Config({ user_id: user._id });
      await Promise.all([config.save(), user.save()]);
    }

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
      const config = await Config.findOne({ user_id: user?._id });
      console.log(verify.decoded, verify.success);
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
    const updateFields: Record<string, any> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) updateFields[key] = value;
    }

    const config = await Config.findOneAndUpdate(
      { user_id },
      { $set: updateFields },
      { new: true }
    );

    if (!config) {
      return sendResponse(
        res,
        false,
        "error",
        ResponseCode.INVALID_INPUT,
        ResponseMessage.INVALID_INPUT
      );
    }
    await config.save();

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
    const userConfig = await Config.findOne({ user_id });

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
    return sendResponse(res, true, "success", 200, "Logout successful");
  } catch (error) {
    return sendResponse(res, false, "error", 500, "Logout failed");
  }
}
export { login, token, refresh, info, config, updateConfig, logout };
