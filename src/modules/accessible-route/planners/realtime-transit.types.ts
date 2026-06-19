/**
 * File-local TDX shapes and cache types for the realtime transit overlay.
 * Minimal shapes scoped to this planner — not the canonical src/types/transit.
 */

export interface TdxEtaRecord {
  EstimateTime?: number | null;
  StopStatus?: number;
  StopName?: { Zh_tw?: string };
  Direction?: number;
}

export interface TdxTrainLiveBoardItem {
  TrainNo?: string;
  DelayTime?: number;
}
export interface TdxTrainLiveBoardEnvelope {
  TrainLiveBoards?: TdxTrainLiveBoardItem[];
}

export type CacheEntry<T> = { data: T; expiresAt: number };

export interface TdxTraStation {
  StationID: string;
  StationName?: { Zh_tw?: string };
}
export interface TdxTraOdItem {
  DailyTrainInfo?: { TrainNo?: string; TrainTypeName?: { Zh_tw?: string } };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
}

export interface TdxThsrStation {
  StationID: string;
  StationName?: { Zh_tw?: string };
}
export interface TdxThsrOdItem {
  DailyTrainInfo?: { TrainNo?: string };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
}

export interface RailOdRow {
  DailyTrainInfo?: { TrainNo?: string; TrainTypeName?: { Zh_tw?: string } };
  OriginStopTime?: { DepartureTime?: string };
  DestinationStopTime?: { ArrivalTime?: string };
}
export interface RailMatch {
  trainNo: string;
  trainType?: string;
  dep: string;
  arr: string;
}
