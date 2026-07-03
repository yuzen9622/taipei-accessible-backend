import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("./campus.service", () => ({
  findNearby: vi.fn(),
  findAll: vi.fn(),
  findByBranchId: vi.fn(),
}));

import { buildTestApp } from "../../../test/test-helpers";
import * as service from "./campus.service";

const app = buildTestApp();
const BASE = "/api/v1/a11y/campus";

const summary = {
  branchId: -2147483633,
  schoolName: "國立臺灣大學",
  branchName: "校總區",
  city: "臺北市",
  address: "臺北市大安區羅斯福路四段1號",
  phone: "02-33663366",
  buildingCount: 120,
  facilityCount: 680,
  facTypeSummary: { 無障礙電梯: 24, 無障礙廁所: 130 },
};

const detail = {
  ...summary,
  _id: "66a1f2c3e4b5a6d7c8e9f0d4",
  schoolId: 1001,
  facilities: [{ facUid: "F1", facType: "無障礙電梯", floors: ["1"], floorIds: ["L1"] }],
  importedAt: "2026-06-24T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/v1/a11y/campus/nearby", () => {
  it("returns 200 + nearby campus summaries for valid coordinates", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([summary] as any);
    const res = await request(app).get(`${BASE}/nearby`).query({ lat: 25.05, lng: 121.51 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].facTypeSummary).toEqual(summary.facTypeSummary);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(25.05, 121.51, 1000, undefined);
  });

  it("passes facType through to the service", async () => {
    vi.mocked(service.findNearby).mockResolvedValue([] as any);
    const res = await request(app)
      .get(`${BASE}/nearby`)
      .query({ lat: 25.05, lng: 121.51, facType: "無障礙電梯" });
    expect(res.status).toBe(200);
    expect(vi.mocked(service.findNearby)).toHaveBeenCalledWith(25.05, 121.51, 1000, "無障礙電梯");
  });

  it("returns 400 (INVALID_INPUT) when lat is missing", async () => {
    const res = await request(app).get(`${BASE}/nearby`).query({ lng: 121.51 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(res.body.data.errors).toBeDefined();
    expect(vi.mocked(service.findNearby)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/a11y/campus", () => {
  it("passes city filter and pagination defaults through to the service", async () => {
    vi.mocked(service.findAll).mockResolvedValue({
      items: [summary],
      totalCount: 1,
      page: 1,
      totalPages: 1,
    } as any);
    const res = await request(app).get(BASE).query({ city: "臺北市" });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.totalCount).toBe(1);
    expect(vi.mocked(service.findAll)).toHaveBeenCalledWith({
      city: "臺北市",
      facType: undefined,
      keyword: undefined,
      page: 1,
      limit: 20,
    });
  });

  it("returns 200 with no filters", async () => {
    vi.mocked(service.findAll).mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      totalPages: 0,
    } as any);
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
  });
});

describe("GET /api/v1/a11y/campus/:branchId", () => {
  it("returns 200 + full detail when found (negative branchId)", async () => {
    vi.mocked(service.findByBranchId).mockResolvedValue(detail as any);
    const res = await request(app).get(`${BASE}/-2147483633`);
    expect(res.status).toBe(200);
    expect(res.body.data.facilities).toHaveLength(1);
    expect(vi.mocked(service.findByBranchId)).toHaveBeenCalledWith(-2147483633);
  });

  it("returns 404 when not found", async () => {
    vi.mocked(service.findByBranchId).mockResolvedValue(null);
    const res = await request(app).get(`${BASE}/999999`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-integer branchId", async () => {
    const res = await request(app).get(`${BASE}/not-an-int`);
    expect(res.status).toBe(400);
    expect(vi.mocked(service.findByBranchId)).not.toHaveBeenCalled();
  });
});

describe("OpenAPI document", () => {
  it("registers the three campus paths", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const paths = res.body.paths ?? {};
    expect(paths["/a11y/campus/nearby"]).toBeDefined();
    expect(paths["/a11y/campus"]).toBeDefined();
    expect(paths["/a11y/campus/{branchId}"]).toBeDefined();
  });
});
