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
  contury: string;
  areacode: string;
  village: string;
  number: string;
  name: string;
  address: string;
  administration: string;
  latitude: number;
  longitude: number;
  grade: string;
  type2: string;
  type: string;
  exec: string;
  diaper: string;
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
