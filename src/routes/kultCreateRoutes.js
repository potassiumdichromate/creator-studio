import { Router } from "express";
import { importKultCreateGame, requireKultCreateKey } from "../controllers/kultCreateController.js";

// Service-to-service routes for Kult Create (see kultCreateController.js).
export const kultCreateRouter = Router();

kultCreateRouter.post("/games", requireKultCreateKey, importKultCreateGame);
