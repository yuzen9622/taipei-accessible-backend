import { ResponseCode } from "../../types/code";
import type {
  BusLeg,
  MetroLeg,
  ThsrLeg,
  TraLeg,
  WalkLeg,
  WalkStep,
} from "../../types/route";

export type RelativeDirection =
  | "正前方"
  | "左前方"
  | "右前方"
  | "左側"
  | "右側"
  | "左後方"
  | "右後方"
  | "正後方";

export type NavInstructionType =
  | "turn"
  | "transit_board"
  | "transit_alight"
  | "facility"
  | "depart"
  | "arrive";

export type NavLegType = "WALK" | "BUS" | "METRO" | "THSR" | "TRA";

export interface NavInstruction {
  text: string;
  type: NavInstructionType;
  bearing: number | null;
  relativeDirection: RelativeDirection | null;
  distanceM: number | null;
  streetName: string | null;
  legType: NavLegType;
  polylineIndex: number | null;
}

export interface NavInstructionsResult {
  instructions: NavInstruction[];
  initialBearing: number;
  totalSteps: number;
  warnings: string[];
}

export interface NavRouteInput {
  routeId?: string;
  legs: unknown[];
}

export type GenerateNavResult =
  | { ok: true; data: NavInstructionsResult }
  | { ok: false; status: ResponseCode; reason: string; message: string };

export const WARN_STEPS_UNAVAILABLE = "ORS_STEPS_UNAVAILABLE";

const KNOWN_LEG_TYPES = new Set<NavLegType>([
  "WALK",
  "BUS",
  "METRO",
  "THSR",
  "TRA",
]);

const COMPASS_TO_DEG: Record<string, number> = {
  NORTH: 0,
  NORTHEAST: 45,
  EAST: 90,
  SOUTHEAST: 135,
  SOUTH: 180,
  SOUTHWEST: 225,
  WEST: 270,
  NORTHWEST: 315,
};

const COMPASS_WORDS = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];

const RAIL_SYSTEM_NAMES: Record<string, string> = {
  TRTC: "台北捷運",
  KRTC: "高雄捷運",
  TMRT: "台中捷運",
  NTMC: "新北捷運",
  KLRT: "高雄輕軌",
  TYMC: "桃園捷運",
};

/**
 * 計算從點 A 到點 B 的初始方位角（forward azimuth，度，0–359，正北 = 0，順時針）。
 * @param from 起點 [lng, lat]
 * @param to 終點 [lng, lat]
 * @returns 方位角（度）
 */
export function calcBearing(
  from: [number, number],
  to: [number, number],
): number {
  const [lng1, lat1] = from.map((v) => (v * Math.PI) / 180);
  const [lng2, lat2] = to.map((v) => (v * Math.PI) / 180);
  const dLng = lng2 - lng1;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * 以使用者當前朝向（heading）與目標方位角（bearing）計算八方位相對方向。
 * @param heading 使用者當前朝向（度，正北 = 0，順時針）
 * @param bearing 目標方位角（度，正北 = 0，順時針）
 * @returns 八方位中文字串
 */
export function calcRelativeDirection(
  heading: number,
  bearing: number,
): RelativeDirection {
  const diff = (bearing - heading + 360) % 360;
  if (diff < 22.5 || diff >= 337.5) return "正前方";
  if (diff < 67.5) return "右前方";
  if (diff < 112.5) return "右側";
  if (diff < 157.5) return "右後方";
  if (diff < 202.5) return "正後方";
  if (diff < 247.5) return "左後方";
  if (diff < 292.5) return "左側";
  return "左前方";
}

/**
 * 將正北方位角（度）轉為八方位中文詞（北 / 東北 / …）。
 * @param deg 方位角（度）
 * @returns 八方位中文詞
 */
export function degToCompassWord(deg: number): string {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_WORDS[idx];
}

function absoluteDirectionToDeg(dir: string | null): number | null {
  if (!dir) return null;
  const deg = COMPASS_TO_DEG[dir.toUpperCase()];
  return deg ?? null;
}

function hasStreetName(step: WalkStep): boolean {
  return !step.bogusName && !!step.streetName && step.streetName.trim() !== "";
}

function stepBearing(
  steps: WalkStep[],
  i: number,
  polyline: [number, number][],
): number | null {
  const fromAbsolute = absoluteDirectionToDeg(steps[i].absoluteDirection);
  if (fromAbsolute !== null) return fromAbsolute;

  const here = steps[i].location;
  const next = steps[i + 1]?.location;
  if (next && (next[0] !== here[0] || next[1] !== here[1])) {
    return Math.round(calcBearing(here, next));
  }
  if (polyline.length >= 2) {
    return Math.round(calcBearing(polyline[0], polyline[1]));
  }
  return null;
}

function nearestPolylineIndex(
  polyline: [number, number][],
  loc: [number, number],
): number | null {
  if (!polyline.length) return null;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const dx = polyline[i][0] - loc[0];
    const dy = polyline[i][1] - loc[1];
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function stepType(relativeDirection: string): NavInstructionType {
  const dir = relativeDirection.toUpperCase();
  if (dir === "ELEVATOR" || dir === "ENTER_STATION" || dir === "EXIT_STATION") {
    return "facility";
  }
  if (dir === "DEPART") return "depart";
  return "turn";
}

function walkStepText(step: WalkStep, bearing: number | null): string {
  const street = step.streetName?.trim() ?? "";
  const named = hasStreetName(step);
  const dir = (step.relativeDirection ?? "CONTINUE").toUpperCase();
  switch (dir) {
    case "DEPART": {
      const compass =
        bearing !== null ? `，方位約 ${bearing} 度（${degToCompassWord(bearing)}）` : "";
      return named ? `請沿「${street}」出發${compass}` : `請出發${compass}`;
    }
    case "CONTINUE":
    case "STRAIGHT":
      return named ? `請繼續直行，沿「${street}」前進` : "請繼續直行";
    case "LEFT":
      return named ? `在「${street}」，請向左轉` : "請向左轉";
    case "RIGHT":
      return named ? `在「${street}」，請向右轉` : "請向右轉";
    case "SLIGHTLY_LEFT":
      return "請稍向左偏";
    case "SLIGHTLY_RIGHT":
      return "請稍向右偏";
    case "HARD_LEFT":
      return "請大幅向左轉";
    case "HARD_RIGHT":
      return "請大幅向右轉";
    case "UTURN_LEFT":
    case "UTURN_RIGHT":
      return "請迴轉";
    case "CIRCLE_CLOCKWISE":
    case "CIRCLE_COUNTERCLOCKWISE":
      return "請進入圓環，依指示繞行";
    case "ELEVATOR":
      return "請進入電梯";
    case "ENTER_STATION":
      return "請進入車站";
    case "EXIT_STATION":
      return "請離開車站";
    default:
      return named ? `請沿「${street}」前進` : "請繼續前行";
  }
}

function exitInfoInstruction(
  exitInfo: NonNullable<WalkLeg["exitInfo"]>,
): NavInstruction {
  const label = exitInfo.exitNumber ? `${exitInfo.exitNumber} 出口` : "出口";
  const text =
    exitInfo.type === "elevator"
      ? `前方為 ${label}電梯，請進入電梯`
      : `前方為 ${label}坡道，請沿坡道前進`;
  return {
    text,
    type: "facility",
    bearing: null,
    relativeDirection: null,
    distanceM: null,
    streetName: null,
    legType: "WALK",
    polylineIndex: null,
  };
}

function walkLegToInstructions(
  leg: WalkLeg,
  isFirstLeg: boolean,
  warnings: string[],
): NavInstruction[] {
  const out: NavInstruction[] = [];
  const polyline = leg.polyline ?? [];
  const steps = leg.steps ?? [];

  if (steps.length > 0) {
    steps.forEach((step, i) => {
      const bearing = stepBearing(steps, i, polyline);
      const type = stepType(step.relativeDirection ?? "CONTINUE");
      out.push({
        text: walkStepText(step, bearing),
        type,
        bearing: type === "facility" ? null : bearing,
        relativeDirection: null,
        distanceM: step.distanceM ?? null,
        streetName: hasStreetName(step) ? step.streetName.trim() : null,
        legType: "WALK",
        polylineIndex: nearestPolylineIndex(polyline, step.location),
      });
    });
  } else {
    const bearing =
      polyline.length >= 2 ? Math.round(calcBearing(polyline[0], polyline[1])) : null;
    const heading = bearing !== null ? degToCompassWord(bearing) : "前";
    out.push({
      text: isFirstLeg
        ? `請朝${heading}方向出發，沿路前往「${leg.to}」`
        : `請沿路前往「${leg.to}」`,
      type: isFirstLeg ? "depart" : "turn",
      bearing,
      relativeDirection: null,
      distanceM: leg.distanceM ?? null,
      streetName: null,
      legType: "WALK",
      polylineIndex: bearing !== null ? 0 : null,
    });
    if (!warnings.includes(WARN_STEPS_UNAVAILABLE)) {
      warnings.push(WARN_STEPS_UNAVAILABLE);
    }
  }

  if (leg.exitInfo) {
    out.push(exitInfoInstruction(leg.exitInfo));
  }
  return out;
}

function transitInstruction(
  text: string,
  type: NavInstructionType,
  legType: NavLegType,
): NavInstruction {
  return {
    text,
    type,
    bearing: null,
    relativeDirection: null,
    distanceM: null,
    streetName: null,
    legType,
    polylineIndex: null,
  };
}

function railSystemName(code: string): string {
  return RAIL_SYSTEM_NAMES[code?.toUpperCase()] ?? code ?? "捷運";
}

function displayTime(value?: string): string {
  if (!value) return "";
  const hhmm = /^\d{1,2}:\d{2}/.exec(value);
  if (hhmm) return hhmm[0];
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
  return value;
}

function busInstructions(leg: BusLeg): NavInstruction[] {
  const waitText =
    typeof leg.estimatedWaitMinutes === "number" && leg.estimatedWaitMinutes > 0
      ? `，預估等候約 ${leg.estimatedWaitMinutes} 分鐘`
      : "";
  const board = `請在「${leg.departureStop}」站牌等候，搭乘公車「${leg.routeName}」${waitText}。`;
  const alight = `抵達「${leg.arrivalStop}」站後請下車。`;
  return [
    transitInstruction(board, "transit_board", "BUS"),
    transitInstruction(alight, "transit_alight", "BUS"),
  ];
}

function metroInstructions(leg: MetroLeg): NavInstruction[] {
  const system = railSystemName(leg.railSystem);
  const ride = leg.rideMinutes ? `，行駛約 ${leg.rideMinutes} 分鐘` : "";
  const facility = leg.facilityHighlights?.some((f) => f.includes("電梯"))
    ? "請優先使用電梯進站。"
    : "請留意進站無障礙設施狀況。";
  const board = `請搭乘${system}「${leg.lineName}」，在「${leg.departureStation}」站上車，往「${leg.arrivalStation}」方向${ride}。${facility}`;
  const alight = `請在「${leg.arrivalStation}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "METRO"),
    transitInstruction(alight, "transit_alight", "METRO"),
  ];
}

function thsrInstructions(leg: ThsrLeg): NavInstruction[] {
  const dep = displayTime(leg.departureTime);
  const arr = displayTime(leg.arrivalTime);
  const depText = dep ? `預計 ${dep} ` : "";
  const arrText = arr ? `，${arr} 抵達` : "，抵達";
  const board = `請搭乘高鐵 ${leg.trainNo} 次列車，${depText}由「${leg.departureStation}」出發${arrText}「${leg.arrivalStation}」。`;
  const alight = `請在「${leg.arrivalStation}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "THSR"),
    transitInstruction(alight, "transit_alight", "THSR"),
  ];
}

function traInstructions(leg: TraLeg): NavInstruction[] {
  const dep = displayTime(leg.departureTime);
  const arr = displayTime(leg.arrivalTime);
  const depText = dep ? `預計 ${dep} ` : "";
  const arrText = arr ? `，${arr} 抵達` : "，抵達";
  const trainType = leg.trainTypeName ? `${leg.trainTypeName} ` : "";
  const board = `請搭乘台鐵${trainType}${leg.trainNo} 次，${depText}由「${leg.departureStation}」出發${arrText}「${leg.arrivalStation}」。`;
  const alight = `請在「${leg.arrivalStation}」站下車。`;
  return [
    transitInstruction(board, "transit_board", "TRA"),
    transitInstruction(alight, "transit_alight", "TRA"),
  ];
}

/**
 * 將一條 AccessibleRoute 攤平為有序的逐步導航指引陣列。步行段優先採用路由
 * 引擎回傳的 steps（OTP `WalkLeg.steps`）；無 steps 時降級為簡化指引並回報警告。
 * 提供 `userHeading` 時，為每個含 bearing 的步驟填入八方位相對方向。
 * @param route 含 legs 的路線物件（由 /accessible-route passthrough）
 * @param userHeading 使用者當前朝向（度，正北 = 0，順時針），選用
 * @returns 成功時回傳指引結果，失敗時回傳錯誤碼與訊息
 */
export function generateNavInstructions(
  route: NavRouteInput,
  userHeading?: number,
): GenerateNavResult {
  const legs = route?.legs;
  if (!Array.isArray(legs) || legs.length === 0) {
    return {
      ok: false,
      status: ResponseCode.INVALID_INPUT,
      reason: "INVALID_ROUTE_INPUT",
      message: "route 欄位格式錯誤或 legs 為空",
    };
  }

  for (const leg of legs) {
    const type = (leg as { type?: string })?.type;
    if (!type || !KNOWN_LEG_TYPES.has(type as NavLegType)) {
      return {
        ok: false,
        status: ResponseCode.INVALID_INPUT,
        reason: "UNSUPPORTED_LEG_TYPE",
        message: `legs 含未支援的型別：${type ?? "(未知)"}`,
      };
    }
  }

  const warnings: string[] = [];
  const instructions: NavInstruction[] = [];

  legs.forEach((rawLeg) => {
    const leg = rawLeg as WalkLeg | BusLeg | MetroLeg | ThsrLeg | TraLeg;
    switch (leg.type) {
      case "WALK":
        instructions.push(
          ...walkLegToInstructions(leg, instructions.length === 0, warnings),
        );
        break;
      case "BUS":
        instructions.push(...busInstructions(leg));
        break;
      case "METRO":
        instructions.push(...metroInstructions(leg));
        break;
      case "THSR":
        instructions.push(...thsrInstructions(leg));
        break;
      case "TRA":
        instructions.push(...traInstructions(leg));
        break;
    }
  });

  instructions.push({
    text: "您已抵達目的地",
    type: "arrive",
    bearing: null,
    relativeDirection: null,
    distanceM: null,
    streetName: null,
    legType: (legs[legs.length - 1] as { type: NavLegType }).type,
    polylineIndex: null,
  });

  if (typeof userHeading === "number") {
    for (const instruction of instructions) {
      if (instruction.bearing !== null) {
        instruction.relativeDirection = calcRelativeDirection(
          userHeading,
          instruction.bearing,
        );
      }
    }
  }

  const initialBearing =
    instructions.find((i) => i.bearing !== null)?.bearing ?? 0;

  return {
    ok: true,
    data: {
      instructions,
      initialBearing,
      totalSteps: instructions.length,
      warnings,
    },
  };
}
