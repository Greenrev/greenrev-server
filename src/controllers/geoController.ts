import type { Response } from "express";
import type { CustomReq } from "../types/auth";
import { sendSuccess } from "../utils/apiResponse";
import { ApiError } from "../utils/errors";
import { reverseGeocode, searchPlaces } from "../services/geoService";

/** GET /geo/search?q=12 Admiralty Way Lekki */
export async function geoSearch(req: CustomReq, res: Response) {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  return sendSuccess(res, 200, { places: await searchPlaces(q) });
}

/** GET /geo/reverse?lat=6.44&lng=3.47 */
export async function geoReverse(req: CustomReq, res: Response) {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ApiError(400, "VALIDATION_ERROR", "lat and lng are required");
  }
  return sendSuccess(res, 200, { place: await reverseGeocode(lat, lng) });
}
