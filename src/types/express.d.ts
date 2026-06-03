import { Express } from "express";
declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
      auth?: { sessionId: string };
    }
  }
}

export {};
