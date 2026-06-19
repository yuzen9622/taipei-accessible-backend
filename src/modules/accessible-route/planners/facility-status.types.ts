/**
 * File-local TDX shapes and cache types for the metro facility status overlay.
 * Minimal shapes scoped to this planner.
 */

export interface TdxStationFacilityItem {
  StationID: string;
  StationName?: { Zh_tw?: string };
  Elevators?: Array<{
    Description?: string;
    FloorLevel?: string;
    Title?: { Zh_tw?: string };
  }>;
  Toilets?: Array<{ Description?: string; FloorLevel?: string }>;
}

export interface TdxMetroAlertEnvelope {
  Alerts?: TdxMetroAlertItem[];
}
export interface TdxMetroAlertItem {
  Title?: string;
  Description?: string;
  Status?: number;
  Scope?: {
    Stations?: Array<{ StationID?: string; StationName?: { Zh_tw?: string } }>;
  };
}

export type CacheEntry<T> = { data: T; expiresAt: number };
