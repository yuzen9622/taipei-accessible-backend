import { model, Schema } from "mongoose";

export interface IGtfsRoute {
  routeId: string;
  agencyId: string;
  routeShortName: string;
  routeLongName: string;
  routeType: 1 | 2 | 3 | 4;
}

const gtfsRouteSchema = new Schema<IGtfsRoute>({
  routeId: { type: String, required: true },
  agencyId: { type: String, required: true },
  routeShortName: { type: String, required: true },
  routeLongName: { type: String, required: true },
  routeType: { type: Number, enum: [1, 2, 3, 4], required: true },
});

gtfsRouteSchema.index({ routeId: 1 }, { unique: true });
gtfsRouteSchema.index({ routeShortName: 1 });

export const GtfsRoute = model<IGtfsRoute>("GtfsRoute", gtfsRouteSchema);
