import jwt, {
  JsonWebTokenError,
  JwtPayload,
  TokenExpiredError,
} from "jsonwebtoken";
import { IUser } from "../types/index";
const createAccessToken = (user: IUser): string => {
  return jwt.sign({ user }, process.env.JWT_ACCESS_SECRET ?? "", {
    expiresIn: "5s",
  });
};

const createRefreshToken = (user: IUser): string => {
  return jwt.sign({ user }, process.env.JWT_REFRESH_SECRET ?? "", {
    expiresIn: "1d",
  });
};

const verifyAccessToken = (token: string) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET ?? "");
    return { success: true, decoded: decoded as JwtPayload };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return { success: false, expired: true };
    } else if (err instanceof JsonWebTokenError) {
      return { success: false, expired: false };
    } else {
      return { success: false, expired: false };
    }
  }
};

const verifyRefreshToken = (token: string) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET ?? "");
    return { success: true, decoded: decoded as JwtPayload };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return { success: false, expired: true };
    } else if (err instanceof JsonWebTokenError) {
      return { success: false, expired: false };
    } else {
      return { success: false, expired: false };
    }
  }
};

export {
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
