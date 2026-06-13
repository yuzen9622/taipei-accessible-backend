import { model, Schema } from "mongoose";

export interface IGtfsStopTime {
  tripId: string;
  stopId: string;
  stopSequence: number;
  arrivalTime: string;
  departureTime: string;
}

const gtfsStopTimeSchema = new Schema<IGtfsStopTime>({
  tripId: { type: String, required: true },
  stopId: { type: String, required: true },
  stopSequence: { type: Number, required: true },
  arrivalTime: { type: String, required: true },
  departureTime: { type: String, required: true },
});

// Primary routing query: all stops in a trip in order
gtfsStopTimeSchema.index({ tripId: 1, stopSequence: 1 });
// Departure-time query: find next departure from a stop
gtfsStopTimeSchema.index({ stopId: 1, departureTime: 1 });

export const GtfsStopTime = model<IGtfsStopTime>(
  "GtfsStopTime",
  gtfsStopTimeSchema
);
