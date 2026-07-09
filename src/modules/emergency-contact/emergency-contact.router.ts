import { Router } from "express";
import { validateRequest } from "../../middleware/validate-request.middleware";
import {
  listContacts,
  createContact,
  deleteContact,
} from "./emergency-contact.controller";
import {
  CreateEmergencyContactSchema,
  ContactIdParamSchema,
} from "./emergency-contact.schema";

export function createEmergencyContactRouter(): Router {
  const router = Router();

  router.get("/emergency-contacts", listContacts);

  router.post(
    "/emergency-contacts",
    validateRequest({ body: CreateEmergencyContactSchema }),
    createContact,
  );

  router.delete(
    "/emergency-contacts/:id",
    validateRequest({ params: ContactIdParamSchema }),
    deleteContact,
  );

  return router;
}
