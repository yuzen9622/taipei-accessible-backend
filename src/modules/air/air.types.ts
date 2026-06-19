/**
 * air module type declarations — the shapes the air-quality service returns.
 */

export interface AirReading {
  area: string | null;
  pm25: number;
  coordinates: [number, number] | undefined;
  city: string | null;
}

export interface AirData {
  city: string;
  readings: AirReading[];
}
