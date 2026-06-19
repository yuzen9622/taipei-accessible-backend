/**
 * Type declarations for the TDX MaaS Routing API client (tdx-routing.ts).
 */

export interface TdxPlace {
  name?: string;
  type?: string;
  location: { lat: number; lng: number };
}
export interface TdxSection {
  type: "pedestrian" | "transit";
  travelSummary?: { duration: number; length: number };
  departure: { time: string; place: TdxPlace };
  arrival: { time: string; place: TdxPlace };
  transport?: {
    mode?: string;
    name?: string;
    category?: string;
    headsign?: string;
    shortName?: string;
    longName?: string;
    number?: string;
    type?: string;
  };
  intermediateStops?: { departure?: { place?: TdxPlace } }[];
  agency?: { agency_id?: string; name?: string };
}
export interface TdxRoute {
  travel_time: number;
  start_time: string;
  end_time: string;
  transfers: number;
  sections: TdxSection[];
}

export interface PlanTdxRouteOptions {
  departureTime?: Date;
  preferFastest?: number;
  top?: number;
  transitModes?: string;
}
