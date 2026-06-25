import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../model/user-memory.model", () => {
  const mockModel: any = {
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    create: vi.fn(),
    countDocuments: vi.fn(),
    deleteMany: vi.fn(),
    deleteOne: vi.fn(),
  };
  return { default: mockModel };
});
vi.mock("../../config/redis", () => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));

import UserMemory from "../../model/user-memory.model";
import { redisGet, redisSet, redisDel } from "../../config/redis";
import { loadMemories, saveMemory, deleteMemory } from "./memory.service";

const mockFind = UserMemory.find as unknown as ReturnType<typeof vi.fn>;
const mockFindOne = UserMemory.findOne as unknown as ReturnType<typeof vi.fn>;
const mockCreate = UserMemory.create as unknown as ReturnType<typeof vi.fn>;
const mockCount = UserMemory.countDocuments as unknown as ReturnType<typeof vi.fn>;
const mockDeleteMany = UserMemory.deleteMany as unknown as ReturnType<typeof vi.fn>;
const mockDeleteOne = UserMemory.deleteOne as unknown as ReturnType<typeof vi.fn>;
const mockFindByIdAndUpdate = UserMemory.findByIdAndUpdate as unknown as ReturnType<typeof vi.fn>;
const mockRedisGet = redisGet as unknown as ReturnType<typeof vi.fn>;
const mockRedisSet = redisSet as unknown as ReturnType<typeof vi.fn>;
const mockRedisDel = redisDel as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadMemories", () => {
  it("Redis 有快取時直接回傳", async () => {
    const cached = [{ _id: "m1", content: "坐輪椅", category: "preference" }];
    mockRedisGet.mockResolvedValue(JSON.stringify(cached));

    const result = await loadMemories("user1");
    expect(result).toEqual(cached);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("Redis miss 時查 MongoDB 並寫入快取", async () => {
    mockRedisGet.mockResolvedValue(null);
    const docs = [
      { _id: "m1", content: "坐輪椅", category: "preference", userId: "u1" },
    ];
    mockFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve(docs) }) }),
    });

    const result = await loadMemories("u1");
    expect(result).toEqual(docs);
    expect(mockRedisSet).toHaveBeenCalledWith(
      "user-mem:u1",
      JSON.stringify(docs),
      300,
    );
  });

  it("MongoDB 也為空時不寫快取", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
    });

    const result = await loadMemories("u1");
    expect(result).toEqual([]);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("saveMemory", () => {
  it("新記憶 — 寫入 + 清快取", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    const created = {
      _id: "m1",
      userId: "u1",
      content: "家住板橋",
      category: "place",
      toObject: () => ({ _id: "m1", userId: "u1", content: "家住板橋", category: "place" }),
    };
    mockCreate.mockResolvedValue(created);
    mockCount.mockResolvedValue(1);

    const result = await saveMemory("u1", "家住板橋", "place");
    expect(result.content).toBe("家住板橋");
    expect(mockRedisDel).toHaveBeenCalledWith("user-mem:u1");
  });

  it("已存在相同內容 — 更新 updatedAt", async () => {
    mockFindOne.mockReturnValue({
      lean: () => Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });
    mockFindByIdAndUpdate.mockReturnValue({
      lean: () => Promise.resolve({ _id: "m1", content: "家住板橋", category: "place" }),
    });

    await saveMemory("u1", "家住板橋", "place");
    expect(mockFindByIdAndUpdate).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ $set: expect.objectContaining({ content: "家住板橋" }) }),
      { new: true },
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("超過 50 筆時刪除最舊的", async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    mockCreate.mockResolvedValue({
      _id: "m51",
      toObject: () => ({ _id: "m51", content: "new", category: "context" }),
    });
    mockCount.mockResolvedValue(51);
    mockFind.mockReturnValue({
      sort: () => ({
        limit: () => ({
          select: () => Promise.resolve([{ _id: "oldest" }]),
        }),
      }),
    });
    mockDeleteMany.mockResolvedValue({ deletedCount: 1 });

    await saveMemory("u1", "new", "context");
    expect(mockDeleteMany).toHaveBeenCalledWith({
      _id: { $in: ["oldest"] },
    });
  });
});

describe("deleteMemory", () => {
  it("成功刪除 — 回 true + 清快取", async () => {
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
    const result = await deleteMemory("u1", "m1");
    expect(result).toBe(true);
    expect(mockRedisDel).toHaveBeenCalledWith("user-mem:u1");
  });

  it("找不到 — 回 false，不清快取", async () => {
    mockDeleteOne.mockResolvedValue({ deletedCount: 0 });
    const result = await deleteMemory("u1", "nonexistent");
    expect(result).toBe(false);
    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});
