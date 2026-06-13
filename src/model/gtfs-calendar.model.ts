import { model, Schema } from "mongoose";

export interface IGtfsCalendar {
  serviceId: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  startDate: string;
  endDate: string;
  exceptions: {
    date: string;
    exceptionType: 1 | 2;
  }[];
}

const gtfsCalendarSchema = new Schema<IGtfsCalendar>({
  serviceId: { type: String, required: true },
  monday: { type: Boolean, required: true },
  tuesday: { type: Boolean, required: true },
  wednesday: { type: Boolean, required: true },
  thursday: { type: Boolean, required: true },
  friday: { type: Boolean, required: true },
  saturday: { type: Boolean, required: true },
  sunday: { type: Boolean, required: true },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  exceptions: [
    {
      date: { type: String, required: true },
      exceptionType: { type: Number, enum: [1, 2], required: true },
    },
  ],
});

gtfsCalendarSchema.index({ serviceId: 1 }, { unique: true });

export const GtfsCalendar = model<IGtfsCalendar>(
  "GtfsCalendar",
  gtfsCalendarSchema
);
