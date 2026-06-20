import { describe, it, expect } from "vitest";
import { cityFromAlias, yesNoLabel, VEHICLE_CLASS_LABEL } from "./bus";
import { TaiwanCityEn } from "../types/transit";

describe("cityFromAlias", () => {
  it("接受中文市名（含台/臺、市/縣後綴變體）", () => {
    expect(cityFromAlias("台北")).toBe(TaiwanCityEn.Taipei);
    expect(cityFromAlias("臺北")).toBe(TaiwanCityEn.Taipei);
    expect(cityFromAlias("台北市")).toBe(TaiwanCityEn.Taipei);
    expect(cityFromAlias("新北")).toBe(TaiwanCityEn.NewTaipei);
    expect(cityFromAlias("新北市")).toBe(TaiwanCityEn.NewTaipei);
    expect(cityFromAlias("臺中市")).toBe(TaiwanCityEn.Taichung);
    expect(cityFromAlias("高雄")).toBe(TaiwanCityEn.Kaohsiung);
  });

  it("接受英文 enum 值與 getCity 風格回傳", () => {
    expect(cityFromAlias("Taipei")).toBe(TaiwanCityEn.Taipei);
    expect(cityFromAlias("NewTaipei")).toBe(TaiwanCityEn.NewTaipei);
    // getCity 會回傳像 "NewTaipei " / "New Taipei City" 這類字串
    expect(cityFromAlias("NewTaipei ")).toBe(TaiwanCityEn.NewTaipei);
    expect(cityFromAlias("New Taipei City")).toBe(TaiwanCityEn.NewTaipei);
  });

  it("區分新竹市與新竹縣、嘉義市與嘉義縣", () => {
    expect(cityFromAlias("新竹")).toBe(TaiwanCityEn.Hsinchu);
    expect(cityFromAlias("新竹縣")).toBe(TaiwanCityEn.HsinchuCounty);
    expect(cityFromAlias("嘉義")).toBe(TaiwanCityEn.Chiayi);
    expect(cityFromAlias("嘉義縣")).toBe(TaiwanCityEn.ChiayiCounty);
  });

  it("無法辨識時回傳 null", () => {
    expect(cityFromAlias(undefined)).toBeNull();
    expect(cityFromAlias("")).toBeNull();
    expect(cityFromAlias("火星市")).toBeNull();
  });
});

describe("yesNoLabel", () => {
  it("1→是、0→否、其他→未知", () => {
    expect(yesNoLabel(1)).toBe("是");
    expect(yesNoLabel(0)).toBe("否");
    expect(yesNoLabel(undefined)).toBe("未知");
    expect(yesNoLabel(-1)).toBe("未知");
  });
});

describe("VEHICLE_CLASS_LABEL", () => {
  it("對應 TDX 車輛型別代碼", () => {
    expect(VEHICLE_CLASS_LABEL[1]).toBe("大型巴士");
    expect(VEHICLE_CLASS_LABEL[2]).toBe("中型巴士");
  });
});
