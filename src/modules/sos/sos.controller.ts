import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import * as service from "./sos.service";
import type { ServiceResult, SosType } from "./sos.types";

function send(res: Response, result: ServiceResult) {
  return sendResponse(
    res,
    result.ok,
    result.ok ? "success" : "error",
    result.httpCode as ResponseCode,
    result.message,
    result.data,
  );
}

async function createSession(req: Request, res: Response) {
  const body = req.validated?.body as {
    type: SosType;
    lat: number;
    lng: number;
    address?: string;
  };
  const result = await service.createSession({
    userId: req.auth!.userId,
    type: body.type,
    lat: body.lat,
    lng: body.lng,
    address: body.address,
  });
  return send(res, result);
}

async function updateLocation(req: Request, res: Response) {
  const params = req.validated?.params as { id: string };
  const body = req.validated?.body as { lat: number; lng: number; address?: string };
  const result = await service.updateLocation({
    userId: req.auth!.userId,
    sessionId: params.id,
    lat: body.lat,
    lng: body.lng,
    address: body.address,
  });
  return send(res, result);
}

async function resolveSession(req: Request, res: Response) {
  const params = req.validated?.params as { id: string };
  const result = await service.resolveSession({
    userId: req.auth!.userId,
    sessionId: params.id,
  });
  return send(res, result);
}

async function getPublicSession(req: Request, res: Response) {
  const params = req.validated?.params as { token: string };
  const result = await service.getPublicByToken(params.token);
  return send(res, result);
}

export { createSession, updateLocation, resolveSession, getPublicSession };
