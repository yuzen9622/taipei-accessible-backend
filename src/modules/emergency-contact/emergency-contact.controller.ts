import type { Request, Response } from "express";
import { sendResponse } from "../../config/lib";
import { ResponseCode } from "../../types/code";
import * as service from "./emergency-contact.service";
import type { ServiceResult } from "./emergency-contact.types";

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

async function listContacts(req: Request, res: Response) {
  const result = await service.listContacts(req.auth!.userId);
  return send(res, result);
}

async function createContact(req: Request, res: Response) {
  const body = req.validated?.body as { name: string };
  const result = await service.createContact({
    userId: req.auth!.userId,
    name: body.name,
  });
  return send(res, result);
}

async function deleteContact(req: Request, res: Response) {
  const params = req.validated?.params as { id: string };
  const result = await service.deleteContact({
    userId: req.auth!.userId,
    contactId: params.id,
  });
  return send(res, result);
}

export { listContacts, createContact, deleteContact };
