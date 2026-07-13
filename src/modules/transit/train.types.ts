import type { RailSystem } from "../../types/rail";

export interface TrainTimetableParams {
  originStation: string;
  destinationStation: string;
  date?: string;
  departAfter?: string;
  arriveBy?: string;
  railSystem?: RailSystem;
}

export interface StationTimetableParams {
  station: string;
  date?: string;
  departAfter?: string;
  railSystem?: RailSystem;
}

export interface TrainTimetableEntry {
  trainNo: string;
  trainType?: string;
  departureTime: string;
  arrivalTime: string;
  arrivesNextDay?: true;
  durationMinutes: number;
}

export interface StationTimetableEntry {
  trainNo: string;
  trainType?: string;
  direction?: number;
  destination?: string;
  departureTime: string;
  arrivalTime?: string;
}

export type TrainTimetableResult =
  | {
      ok: true;
      railSystem: RailSystem;
      date: string;
      origin: { name: string; stationID: string };
      destination: { name: string; stationID: string };
      totalCount: number;
      matchedCount: number;
      firstTrain: string | null;
      lastTrain: string | null;
      trains: TrainTimetableEntry[];
      note?: string;
    }
  | { ok: false; error: string };

export type StationTimetableResult =
  | {
      ok: true;
      railSystem: RailSystem;
      date: string;
      station: { name: string; stationID: string };
      departAfter: string;
      totalCount: number;
      matchedCount: number;
      firstTrain: string | null;
      lastTrain: string | null;
      trains: StationTimetableEntry[];
      note?: string;
    }
  | { ok: false; error: string };
