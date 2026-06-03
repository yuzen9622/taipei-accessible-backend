import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { ResponseCode } from "../types/code";

interface ValidateSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export function validateRequest(schemas: ValidateSchemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: { path: string; message: string }[] = [];
    const validated: Record<string, unknown> = {};

    const targets: [keyof ValidateSchemas, unknown][] = [
      ["body", req.body],
      ["query", req.query],
      ["params", req.params],
    ];

    for (const [key, value] of targets) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(value);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          errors.push({ path: issue.path.join("."), message: issue.message });
        });
      } else {
        validated[key] = result.data;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        ok: false,
        status: "error",
        code: ResponseCode.INVALID_INPUT,
        message: "Invalid request.",
        data: { errors },
      });
    }

    req.validated = validated;
    next();
  };
}
