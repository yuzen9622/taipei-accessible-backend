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
