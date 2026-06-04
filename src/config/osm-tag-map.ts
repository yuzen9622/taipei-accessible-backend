export const OSM_TAG_MAP = {
  // ── transport_infra ──────────────────────────────────────────────
  highway: {
    mapKey: "highwayType",
    label: "道路/交通設施類型",
    category: "transport_infra",
    values: {
      bus_stop: "公車站",
      traffic_signals: "交通號誌",
      platform: "月台/站台",
      elevator: "電梯",
      crossing: "行人穿越道",
    } as Record<string, string>,
  },
  public_transport: {
    mapKey: "publicTransportRole",
    label: "大眾運輸角色",
    category: "transport_infra",
    values: {
      stop_position: "站牌位置",
      station: "車站",
      platform: "月台",
    } as Record<string, string>,
  },
  railway: {
    mapKey: "railwayType",
    label: "鐵路設施類型",
    category: "transport_infra",
    values: {
      stop: "停靠站",
      station: "車站",
      halt: "招呼站",
      proposed: "規劃中",
      subway_entrance: "捷運出入口",
    } as Record<string, string>,
  },
  bus: {
    mapKey: "isBusStop",
    label: "公車站點",
    category: "transport_infra",
    values: {
      yes: "是",
    } as Record<string, string>,
  },
  subway: {
    mapKey: "isSubwayStation",
    label: "捷運站",
    category: "transport_infra",
    values: {
      yes: "是",
    } as Record<string, string>,
  },
  train: {
    mapKey: "isTrainStation",
    label: "火車站",
    category: "transport_infra",
    values: {
      yes: "是",
    } as Record<string, string>,
  },
  light_rail: {
    mapKey: "isLightRail",
    label: "輕軌站",
    category: "transport_infra",
    values: {
      yes: "是",
    } as Record<string, string>,
  },
  station: {
    mapKey: "stationType",
    label: "車站類型",
    category: "transport_infra",
    values: {
      train: "火車",
      light_rail: "輕軌",
      subway: "地鐵/捷運",
    } as Record<string, string>,
  },
  shelter: {
    mapKey: "hasShelter",
    label: "有遮蔽設施",
    category: "transport_infra",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  bench: {
    mapKey: "hasBench",
    label: "有座椅",
    category: "transport_infra",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  passenger_information_display: {
    mapKey: "hasPassengerInfoDisplay",
    label: "旅客資訊顯示器",
    category: "transport_infra",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  departures_board: {
    mapKey: "departuresBoard",
    label: "班次資訊看板",
    category: "transport_infra",
    values: {
      timetable: "時刻表",
      realtime: "即時資訊",
      "yes;realtime;timetable": "即時及時刻表",
      yes: "有",
    } as Record<string, string>,
  },
  platform_protection: {
    mapKey: "platformProtection",
    label: "月台防護設施",
    category: "transport_infra",
    values: {
      door: "月台屏蔽門",
    } as Record<string, string>,
  },
  network: {
    mapKey: "transitNetwork",
    label: "所屬運輸網路",
    category: "transport_infra",
  },
  route_ref: {
    mapKey: "routeRef",
    label: "路線編號",
    category: "transport_infra",
  },
  bicycle_rental: {
    mapKey: "bikeRentalType",
    label: "自行車租借類型",
    category: "transport_infra",
    values: {
      docking_station: "停靠站式",
    } as Record<string, string>,
  },

  // ── wheelchair_access ────────────────────────────────────────────
  wheelchair: {
    mapKey: "wheelchairAccess",
    label: "輪椅通行",
    category: "wheelchair_access",
    values: {
      yes: "可通行",
      limited: "部分可通行",
      designated: "專用設施",
      no: "不可通行",
    } as Record<string, string>,
  },
  "wheelchair:description": {
    mapKey: "wheelchairDescription",
    label: "輪椅通行說明",
    category: "wheelchair_access",
  },
  "check_date:wheelchair": {
    mapKey: "wheelchairCheckDate",
    label: "輪椅資訊核查日期",
    category: "wheelchair_access",
  },
  "ramp:wheelchair": {
    mapKey: "wheelchairRamp",
    label: "輪椅坡道",
    category: "wheelchair_access",
    values: {
      yes: "有",
      no: "無",
      limited: "部分",
    } as Record<string, string>,
  },
  ramp: {
    mapKey: "hasRamp",
    label: "坡道",
    category: "wheelchair_access",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  elevator: {
    mapKey: "hasElevator",
    label: "電梯",
    category: "wheelchair_access",
    values: {
      yes: "有電梯",
      wheelchair: "無障礙電梯",
    } as Record<string, string>,
  },
  automatic_door: {
    mapKey: "hasAutomaticDoor",
    label: "自動門",
    category: "wheelchair_access",
    values: {
      yes: "是",
    } as Record<string, string>,
  },
  "pedestrian arcade:wheelchair": {
    mapKey: "pedestrianArcadeWheelchair",
    label: "騎樓輪椅通行",
    category: "wheelchair_access",
    values: {
      yes: "可通行",
      limited: "部分可行",
      no: "不可通行",
    } as Record<string, string>,
  },

  // ── toilet_facilities ────────────────────────────────────────────
  "toilets:wheelchair": {
    mapKey: "hasAccessibleToilet",
    label: "無障礙廁所",
    category: "toilet_facilities",
    values: {
      yes: "可使用",
      limited: "部分可用",
      designated: "專用",
      no: "不可使用",
    } as Record<string, string>,
  },
  toilets: {
    mapKey: "hasToilet",
    label: "廁所",
    category: "toilet_facilities",
    values: {
      yes: "有",
      no: "無",
      customers: "顧客專用",
    } as Record<string, string>,
  },
  "toilets:access": {
    mapKey: "toiletAccess",
    label: "廁所開放對象",
    category: "toilet_facilities",
    values: {
      permissive: "一般開放",
      customers: "顧客專用",
      private: "私人使用",
      yes: "公開開放",
    } as Record<string, string>,
  },
  "toilets:disposal": {
    mapKey: "toiletDisposal",
    label: "廁所沖水方式",
    category: "toilet_facilities",
    values: {
      bucket: "桶水沖洗",
      flush: "水箱沖水",
      pitlatrine: "旱坑式",
      chemical: "化學處理",
    } as Record<string, string>,
  },
  "toilets:handwashing": {
    mapKey: "toiletHandwashing",
    label: "廁所洗手設備",
    category: "toilet_facilities",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  "toilets:position": {
    mapKey: "toiletPosition",
    label: "馬桶類型",
    category: "toilet_facilities",
    values: {
      seated: "坐式",
      squat: "蹲式",
      urinal: "小便斗",
      inside: "室內",
    } as Record<string, string>,
  },
  changing_table: {
    mapKey: "changingTable",
    label: "尿布台",
    category: "toilet_facilities",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  fee: {
    mapKey: "fee",
    label: "收費",
    category: "toilet_facilities",
    values: {
      yes: "收費",
      no: "免費",
    } as Record<string, string>,
  },
  unisex: {
    mapKey: "unisex",
    label: "性別使用",
    category: "toilet_facilities",
    values: {
      yes: "男女共用",
      male: "男性專用",
      female: "女性專用",
      no: "非男女共用",
    } as Record<string, string>,
  },
  female: {
    mapKey: "femaleToilet",
    label: "女用廁所",
    category: "toilet_facilities",
    values: {
      yes: "有女廁",
      only: "僅限女性",
    } as Record<string, string>,
  },
  male: {
    mapKey: "maleToilet",
    label: "男用廁所",
    category: "toilet_facilities",
    values: {
      yes: "有男廁",
      no: "無男廁",
    } as Record<string, string>,
  },
  baby_feeding: {
    mapKey: "babyFeeding",
    label: "哺乳室",
    category: "toilet_facilities",
    values: {
      room: "獨立哺乳室",
      no: "無",
    } as Record<string, string>,
  },
  opening_hours: {
    mapKey: "openingHours",
    label: "開放時間",
    category: "toilet_facilities",
  },
  locked: {
    mapKey: "locked",
    label: "是否上鎖",
    category: "toilet_facilities",
    values: {
      yes: "上鎖",
      no: "未上鎖",
    } as Record<string, string>,
  },

  // ── path_surface ─────────────────────────────────────────────────
  kerb: {
    mapKey: "kerbType",
    label: "路緣石類型",
    category: "path_surface",
    values: {
      no: "無路緣石",
      lowered: "降低路緣石",
      raised: "抬高路緣石",
      flush: "平齊路面",
    } as Record<string, string>,
  },
  tactile_paving: {
    mapKey: "hasTactilePaving",
    label: "導盲磚",
    category: "path_surface",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  lit: {
    mapKey: "isLit",
    label: "夜間照明",
    category: "path_surface",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  barrier: {
    mapKey: "barrierType",
    label: "障礙物類型",
    category: "path_surface",
    values: {
      motorcycle_barrier: "機車防入障礙",
      lift_gate: "升降桿",
      "full-height_turnstile": "全高旋轉門",
      kerb: "路緣石",
      bollard: "防撞柱",
      cycle_barrier: "自行車防入障礙",
      sliding_gate: "滑動閘門",
      block: "水泥墩",
    } as Record<string, string>,
  },
  crossing: {
    mapKey: "crossingType",
    label: "行人穿越道類型",
    category: "path_surface",
    values: {
      unmarked: "無標線",
      uncontrolled: "無號誌管制",
      zebra: "斑馬線",
      "marked;traffic_signals": "有標線且有號誌",
      "marked;uncontrolled": "有標線但無號誌",
      marked: "有標線",
      traffic_signals: "號誌管制",
    } as Record<string, string>,
  },
  "crossing:island": {
    mapKey: "hasCrossingIsland",
    label: "有行人庇護島",
    category: "path_surface",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  "crossing:markings": {
    mapKey: "crossingMarkings",
    label: "穿越道標線",
    category: "path_surface",
    values: {
      yes: "有標線",
      zebra: "斑馬線",
    } as Record<string, string>,
  },
  "crossing:signals": {
    mapKey: "hasCrossingSignals",
    label: "有行人號誌",
    category: "path_surface",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  "traffic_signals:sound": {
    mapKey: "hasAudioSignal",
    label: "有音響號誌",
    category: "path_surface",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  "traffic_signals:vibration": {
    mapKey: "hasVibrationSignal",
    label: "有震動號誌",
    category: "path_surface",
    values: {
      yes: "有",
      no: "無",
    } as Record<string, string>,
  },
  foot: {
    mapKey: "footAccess",
    label: "行人通行許可",
    category: "path_surface",
    values: {
      yes: "允許",
      permit: "需許可",
      limited: "受限",
      private: "私有",
      designated: "專用",
      permissive: "默許",
    } as Record<string, string>,
  },
  button_operated: {
    mapKey: "isButtonOperated",
    label: "按鈕控制號誌",
    category: "path_surface",
    values: {
      yes: "是",
      no: "否",
    } as Record<string, string>,
  },

  // ── building_features ────────────────────────────────────────────
  access: {
    mapKey: "accessLevel",
    label: "進出限制",
    category: "building_features",
    values: {
      yes: "公開開放",
      no: "禁止",
      permissive: "允許",
      customers: "顧客限定",
      private: "私人",
      permit: "需許可",
      limited: "有限制",
      unknown: "不明",
    } as Record<string, string>,
  },
  amenity: {
    mapKey: "amenityType",
    label: "設施類型",
    category: "building_features",
    values: {
      toilets: "公共廁所",
    } as Record<string, string>,
  },
  entrance: {
    mapKey: "entranceType",
    label: "入口類型",
    category: "building_features",
    values: {
      yes: "一般入口",
      main: "主入口",
      secondary: "次要入口",
      staircase: "樓梯入口",
      service: "服務出入口",
      home: "住宅入口",
      shop: "商店入口",
      gate: "閘門",
      entrance: "入口",
    } as Record<string, string>,
  },
  door: {
    mapKey: "doorType",
    label: "門的類型",
    category: "building_features",
    values: {
      automatic: "自動門",
      sliding: "推拉門",
      hinged: "鉸鏈門",
      double: "雙扇門",
      overhead: "捲門",
      gate: "閘門",
      no: "無門",
      yes: "有門",
    } as Record<string, string>,
  },
  building: {
    mapKey: "buildingType",
    label: "建築類型",
    category: "building_features",
    values: {
      yes: "建築物",
      public: "公共建築",
      retail: "零售商業建築",
      university: "大學校舍",
    } as Record<string, string>,
  },
  covered: {
    mapKey: "isCovered",
    label: "有遮蔽",
    category: "building_features",
    values: {
      no: "無",
      booth: "電話亭式",
      yes: "有",
    } as Record<string, string>,
  },
  indoor: {
    mapKey: "isIndoor",
    label: "室內設施",
    category: "building_features",
    values: {
      "1": "室內",
      yes: "室內",
      no: "室外",
      room: "房間",
      door: "門口",
      area: "區域",
    } as Record<string, string>,
  },
  level: {
    mapKey: "floorLevel",
    label: "所在樓層",
    category: "building_features",
  },
  "addr:floor": {
    mapKey: "addressFloor",
    label: "地址樓層",
    category: "building_features",
  },
  layer: {
    mapKey: "verticalLayer",
    label: "垂直層級",
    category: "building_features",
  },
  parking: {
    mapKey: "parkingType",
    label: "停車場類型",
    category: "building_features",
    values: {
      "multi-storey": "多層停車場",
      underground: "地下停車場",
      surface: "平面停車場",
      layby: "路邊停車灣",
    } as Record<string, string>,
  },
} as const;

export type OsmFeature = {
  key: string;
  label: string;
  value?: string;
  valueLabel?: string;
};

const CATEGORY_ORDER: Record<string, number> = {
  transport_infra: 0,
  wheelchair_access: 1,
  toilet_facilities: 2,
  path_surface: 3,
  building_features: 4,
};

/** Parses a raw OSM tags object into a sorted array of human-readable OsmFeature entries. */
export function parseOsmFeatures(tags: Record<string, string>): OsmFeature[] {
  const results: OsmFeature[] = [];

  for (const [osmKey, entry] of Object.entries(OSM_TAG_MAP)) {
    const rawValue = tags[osmKey];
    if (rawValue === undefined) continue;
    if (rawValue === "no") continue;

    const feature: OsmFeature = {
      key: osmKey,
      label: entry.label,
      value: rawValue,
    };

    const entryWithValues = entry as typeof entry & {
      values?: Record<string, string>;
    };
    if (entryWithValues.values) {
      const valueLabel = entryWithValues.values[rawValue];
      if (valueLabel !== undefined) {
        feature.valueLabel = valueLabel;
      }
    }

    results.push(feature);
  }

  return results.sort((a, b) => {
    const catA =
      CATEGORY_ORDER[
        (OSM_TAG_MAP as Record<string, { category: string }>)[a.key]?.category
      ] ?? 99;
    const catB =
      CATEGORY_ORDER[
        (OSM_TAG_MAP as Record<string, { category: string }>)[b.key]?.category
      ] ?? 99;
    return catA - catB;
  });
}
