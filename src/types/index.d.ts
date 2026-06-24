export interface IUser {
  _id: string;
  name: string;
  avatar?: string;
  email: string;
  client_id: string;
  createdAt: string;
  updatedAt: string;
}

export interface IConfig {
  language: string;
  darkMode: "light" | "dark" | "system";
  themeColor: string;
  fontSize: string;
  notifications: boolean;
  user_id: Schema.Types.ObjectId;
}

export interface IA11y {
  _id: string;
  項次: string;
  "出入口電梯/無障礙坡道名稱": string;
  經度: number;
  緯度: number;
  location: { type: "Point"; coordinates: [number, number] };
}

export interface IBathroom {
  _id: string;
  county: string;
  areacode: string;
  village: string;
  number: string;
  name: string;
  address: string;
  administration: string;
  latitude: number;
  longitude: number;
  location: { type: "Point"; coordinates: [number, number] };
  grade: string;
  type2: string;
  type: string;
  exec: string;
  diaper: string;
}

export interface IDisabledParking {
  _id: string;
  city: string;
  district: string;
  areacode: string;
  quantity: number;
  placeName: string;
  chargeType: string;
  spaceLabel: string;
  isMarked: boolean;
  latitude: number;
  longitude: number;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface IWelfare {
  _id: string;
  name: string;
  county: string;
  district: string;
  address: string;
  phone: string;
  type: string;
  approvedCapacity: { residential: number; night: number; day: number };
  actualServed: { residential: number; night: number; day: number };
  evaluationTerm: string;
  evaluationGrade: string;
  geocoded: boolean;
  location?: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface RankRequest {
  start: google.maps.LatLngLiteral;
  end: google.maps.LatLngLiteral;
  instructions: string;
  duration: number;
  a11y: [];
}

export interface AIRankResponse {
  route_description: string;
  route_total_score: number;
}

export interface ITdxBusStop {
  stopUid: string;
  stopName: { Zh_tw: string; En?: string };
  city: string;
  subRouteIds: string[];
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ITdxBusRouteStop {
  stopUID: string;
  stopId?: string;
  stopName: { Zh_tw: string; En?: string };
  seq: number;
  lat?: number;
  lng?: number;
}

export interface ITdxBusRoute {
  subRouteUid: string;
  routeUid: string;
  routeId?: string;
  city: string;
  routeName: { Zh_tw: string; En?: string };
  subRouteName?: { Zh_tw: string; En?: string };
  direction: number;
  operators: { id?: string; name?: string }[];
  stops: ITdxBusRouteStop[];
  importedAt: Date;
}

export interface ITdxBusVehicle {
  plateNumb: string;
  city: string;
  operatorId?: string;
  vehicleClass?: number;
  vehicleType?: number;
  isLowFloor?: number;
  hasLiftOrRamp?: number;
  isElectric?: number;
  isHybrid?: number;
  hasWifi?: number;
  importedAt: Date;
}

export interface IOsmA11y {
  osmId: string;
  name?: string;
  category: "wheelchair_accessible" | "kerb_cut" | "ramp" | "elevator" | "toilet";
  wheelchair?: "yes" | "limited" | "no";
  tags: Record<string, string>;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ITdxMetroStation {
  stationUid: string;
  stationName: { Zh_tw: string; En?: string };
  railSystem: string;
  lineIds: string[];
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface ITdxTrainStation {
  stationUID: string;
  stationID: string;
  stationName: { Zh_tw: string; En?: string };
  railSystem: string;
  location: { type: "Point"; coordinates: [number, number] };
  importedAt: Date;
}

export interface AgentResponse {
  action:
    | "findNearbyA11y"
    | "transportInfo"
    | "locationAccessibility"
    | "googleSearch"
    | "feedback";
  type?: string;
  range?: number;
  location?: { lat: number; lng: number };
  routeId?: string;
  origin?: object | string;
  destination?: object | string;
  query?: string;
}

export interface IGtfsLevel {
  levelId: string;
  levelIndex: number;
  levelName: string;
}

export interface IGtfsPathway {
  pathwayId: string;
  fromStopId: string;
  toStopId: string;
  pathwayMode: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  isBidirectional: 0 | 1;
  traversalTime?: number;
  stairCount?: number;
}

export interface IGtfsStop {
  stopId: string;
  stopName: string;
  stopLat: number;
  stopLon: number;
  zoneId?: string;
  locationType: 0 | 1 | 2 | 3;
  parentStation?: string;
  levelId?: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
}

export interface IGtfsTrip {
  tripId: string;
  routeId: string;
  serviceId: string;
  shapeId?: string;
  directionId: 0 | 1;
  bikesAllowed?: 0 | 1 | 2;
}

export type HazardType = "obstacle" | "construction" | "data_error";
export type AiVerdict = "verified" | "suspicious" | "rejected" | "skipped";
export type HazardStatus = "pending" | "verified" | "rejected" | "expired";

export interface IHazardReport {
  _id: string;
  reporterId: string;
  reportedLocation: { type: "Point"; coordinates: [number, number] };
  reporterLocation: { type: "Point"; coordinates: [number, number] };
  distanceM: number;
  hazardType: HazardType;
  description?: string;
  photoUrl: string;
  photoStoragePath: string;
  exifValidation: {
    timestampFresh: boolean;
    gpsPresent: boolean;
    gpsMatchesClaimed: boolean;
    rawExifTime?: string;
    rawExifLat?: number;
    rawExifLng?: number;
  };
  aiVerification: {
    verdict: AiVerdict;
    confidence: number;
    reason: string;
    prefilter?: {
      passed?: boolean;
      detectedLabels?: string[];
      safeSearchBlocked?: boolean;
    };
    attemptedAt?: Date;
  };
  status: HazardStatus;
  confirmCount: number;
  denyCount: number;
  confirmedBy: string[];
  deniedBy: string[];
  createdAt: Date;
  updatedAt: Date;
  expiredAt: Date;
}
