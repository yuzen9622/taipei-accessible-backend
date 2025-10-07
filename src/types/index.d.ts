export interface IUser {
  _id: string;
  name: string;
  avatar?: string;
  email: string;
  client_id: string;
  createdAt: string;
  updatedAt: string;
}

export interface IA11y {
  _id: string;
  項次: string;
  "出入口電梯/無障礙坡道名稱": string;
  經度: number;
  緯度: number;
  location: { type: "Point"; coordinates: [number, number] };
}
