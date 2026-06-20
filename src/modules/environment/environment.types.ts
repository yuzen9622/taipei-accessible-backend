/**
 * Response types for the pre-trip environment aggregation endpoint. Each data
 * block carries its own `status` so any one source can degrade independently.
 */

export type DataStatus = "ok" | "unavailable";

export interface WeatherBlock {
  status: DataStatus;
  temperature?: number;
  precipitationProbability?: number;
  windSpeed?: number;
  windDirection?: string;
  condition?: string;
  forecastTime?: string;
  reason?: string;
}

export interface AirQualityBlock {
  status: DataStatus;
  pm25?: number;
  quality?: string;
  advice?: string;
  area?: string | null;
  stationCoordinates?: [number, number] | null;
  reason?: string;
}

export interface CctvCamera {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  distanceM: number;
  snapshotUrl: string | null;
  streamUrl: string | null;
}

export interface CctvBlock {
  status: DataStatus;
  cameras?: CctvCamera[];
  reason?: string;
}

export interface EnvironmentData {
  location: { lat: number; lng: number };
  weather: WeatherBlock;
  airQuality: AirQualityBlock;
  nearbyCctv: CctvBlock;
}

export interface CwaTimeEntry {
  DataTime?: string;
  StartTime?: string;
  EndTime?: string;
  ElementValue: Array<Record<string, string>>;
}

export interface CwaWeatherElement {
  ElementName: string;
  Time: CwaTimeEntry[];
}

export interface CwaLocation {
  LocationName: string;
  Latitude: string;
  Longitude: string;
  WeatherElement: CwaWeatherElement[];
}

export interface RawCamera {
  id: string;
  name: string;
  lat: number;
  lon: number;
  cam_url?: string;
}
