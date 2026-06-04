export enum TaiwanCityEn {
  Taipei = "Taipei",
  NewTaipei = "NewTaipei",
  Taoyuan = "Taoyuan",
  Taichung = "Taichung",
  Tainan = "Tainan",
  Kaohsiung = "Kaohsiung",
  Keelung = "Keelung",
  Hsinchu = "Hsinchu",
  HsinchuCounty = "HsinchuCounty",
  MiaoliCounty = "MiaoliCounty",
  ChanghuaCounty = "ChanghuaCounty",
  NantouCounty = "NantouCounty",
  YunlinCounty = "YunlinCounty",
  ChiayiCounty = "ChiayiCounty",
  Chiayi = "Chiayi",
  PingtungCounty = "PingtungCounty",
  YilanCounty = "YilanCounty",
  HualienCounty = "HualienCounty",
  TaitungCounty = "TaitungCounty",
  KinmenCounty = "KinmenCounty",
  PenghuCounty = "PenghuCounty",
  LienchiangCounty = "LienchiangCounty",
}
export type BusStop = {
  StopUID: string;
  StopID: string;
  StopName: {
    Zh_tw: string;
    En: string;
  };
  StopBoarding: number;
  StopSequence: number;
  StopPosition: {
    PositionLon: number;
    PositionLat: number;
    GeoHash: string;
  };
  StationID: string;
  StationGroupID: string;
  LocationCityCode: string;
};
export type BusOperator = {
  OperatorID: string;
  OperatorName: {
    Zh_tw: string;
    En: string;
  };
  OperatorCode: string;
  OperatorNo: string;
};
export type BusRoute = {
  RouteUID: string;
  RouteID: string;
  RouteName: {
    Zh_tw: string;
    En: string;
  };
  Operators: BusOperator[];
  SubRouteUID: string;
  SubRouteID: string;
  SubRouteName: {
    Zh_tw: string;
    En: string;
  };
  Direction: number;
  City: string;
  CityCode: string;
  Stops: BusStop[];
};

export type BusRealTimeByFrequency = {
  PlateNumb: string;
  Direction: 0 | 1;
  BusPosition: {
    PositionLon: number;
    PositionLat: number;
  };
  Speed?: number;
  DutyStatus: number;
  BusStatus: number;
  GPSTime?: string;
};

export type BusRealtimeNearbyStop = {
  PlateNumb: string;
  OperatorID: string;
  OperatorNo: string;
  RouteUID: string;
  RouteID: string;
  RouteName: {
    Zh_tw: string;
    En: string;
  };
  SubRouteUID: string;
  SubRouteID: string;
  SubRouteName: {
    Zh_tw: string;
    En: string;
  };
  Direction: 0 | 1; // 0 或 1
  StopUID: string;
  StopID: string;
  StopName: {
    Zh_tw: string;
    En: string;
  };
  StopSequence: number;
  MessageType: number;
  DutyStatus: number;
  BusStatus: number;
  A2EventType: number;
  GPSTime: string; // ISO 8601 日期字串
  TripStartTimeType: number;
  TripStartTime: string;
  TransTime: string;
  SrcRecTime: string;
  SrcTransTime: string;
  SrcUpdateTime: string;
  UpdateTime: string;
};

// ─── Metro TDX response shapes ────────────────────────────────────────────────
// Note: TDX Metro APIs use bare IDs (e.g. "G0") not prefixed UIDs ("TMRT-G0").
// The import script and service construct full UIDs by prepending the railSystem.

export type TdxMetroStation = {
  StationUID: string;        // prefixed, e.g. "TMRT-G0"
  StationID: string;         // bare, e.g. "G0"
  StationName: { Zh_tw: string; En: string };
  StationPosition: { PositionLon: number; PositionLat: number };
};

export type TdxMetroStationOfLine = {
  LineID: string;            // bare, e.g. "G" (no system prefix, no Direction field)
  Stations: Array<{
    Sequence: number;
    StationID: string;       // bare, e.g. "G0"
    StationName: { Zh_tw: string; En: string };
    CumulativeDistance?: number;
  }>;
};

export type TdxMetroS2STravelTimeRecord = {
  LineID: string;
  RouteID?: string;
  TravelTimes: Array<{
    Sequence: number;
    FromStationID: string;   // bare, e.g. "G0"
    ToStationID: string;
    RunTime: number;         // SECONDS
    StopTime: number;
  }>;
};

export type TdxMetroFrequencyRecord = {
  LineID: string;
  RouteID?: string;
  Headways: Array<{
    StartTime?: string;      // "HH:mm"
    EndTime?: string;
    MinHeadwayMins: number;
    MaxHeadwayMins: number;
  }>;
  OperationTime?: { StartTime: string; EndTime: string };
};

export type TdxMetroStationFacility = {
  StationUID: string;
  Facilities: Array<{
    FacilityType: number;
    FacilityName?: { Zh_tw: string };
    Quantity?: number;
  }>;
};

// ─── THSR TDX response shapes ─────────────────────────────────────────────────

export type TdxThsrStation = {
  StationUID: string;        // e.g. "THSR-0990"
  StationID: string;         // e.g. "0990"
  StationName: { Zh_tw: string; En: string };
  StationAddress?: string;
  StationPosition: { PositionLon: number; PositionLat: number };
};

export type TdxThsrGeneralTimetableItem = {
  GeneralTimetable: {
    GeneralTrainInfo: {
      TrainNo: string;
      Direction: 0 | 1;
      StartingStationID: string;
      EndingStationID: string;
      Notes?: string;
    };
    StopTimes: Array<{
      Sequence: number;
      StationID: string;
      StationName: { Zh_tw: string; En: string };
      ArrivalTime: string;    // "HH:mm"
      DepartureTime: string;  // "HH:mm"
    }>;
    ServiceDay?: {
      Sunday: boolean; Monday: boolean; Tuesday: boolean;
      Wednesday: boolean; Thursday: boolean; Friday: boolean; Saturday: boolean;
    };
  };
};

export type TdxThsrStationFacility = {
  StationUID: string;
  Facilities?: Array<{
    FacilityType: number;
    FacilityName?: { Zh_tw: string };
    Quantity?: number;
  }>;
};

// ─── TRA TDX response shapes ──────────────────────────────────────────────────

export type TdxTraStation = {
  StationUID: string;        // e.g. "TRA-1000"
  StationID: string;         // e.g. "1000"
  StationName: { Zh_tw: string; En: string };
  StationAddress?: string;
  StationPosition: { PositionLon: number; PositionLat: number };
};

export type TdxTraGeneralTimetableItem = {
  TrainInfo: {
    TrainNo: string;
    Direction: 0 | 1;
    TrainTypeID?: string;
    TrainTypeName?: { Zh_tw: string; En?: string };
    StartingStationID: string;
    EndingStationID: string;
    Wheelchair?: number;    // 1=yes, 2=no, 3=partial
    Notes?: string;
  };
  StopTimes: Array<{
    Sequence: number;
    StationID: string;
    StationName: { Zh_tw: string; En: string };
    ArrivalTime: string;    // "HH:mm"
    DepartureTime: string;  // "HH:mm"
    DropOffTime?: string;
    PickupTime?: string;
  }>;
};

export type TdxTraStationFacility = {
  StationUID: string;
  Facilities?: Array<{
    FacilityType: number;
    FacilityName?: { Zh_tw: string };
    Quantity?: number;
  }>;
};
