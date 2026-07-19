import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../../config/redis", () => ({
  redisClient: redisMock,
}));

import { appendLineChatTurn, getLineChatHistory } from "./line-memory";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
});

describe("line-memory", () => {
  it("keeps the latest 10 turns and resets the 30-minute TTL", async () => {
    const existing = Array.from({ length: 10 }, (_, index) => [
      { role: "user", content: `user-${index}` },
      { role: "assistant", content: `assistant-${index}` },
    ]).flat();
    redisMock.get.mockResolvedValue(JSON.stringify(existing));

    await appendLineChatTurn("U1", "new-user", "new-assistant");

    expect(redisMock.set).toHaveBeenCalledTimes(1);
    const [key, raw, mode, ttl] = redisMock.set.mock.calls[0];
    const stored = JSON.parse(raw);
    expect(key).toBe("line:chat:U1");
    expect(mode).toBe("EX");
    expect(ttl).toBe(1800);
    expect(stored).toHaveLength(20);
    expect(stored[0]).toEqual({ role: "user", content: "user-1" });
    expect(stored.at(-1)).toEqual({
      role: "assistant",
      content: "new-assistant",
    });
  });

  it("returns an empty history when Redis read fails", async () => {
    redisMock.get.mockRejectedValue(new Error("redis down"));

    await expect(getLineChatHistory("U1")).resolves.toEqual([]);
  });

  it("does not throw when Redis write fails", async () => {
    redisMock.set.mockRejectedValue(new Error("redis down"));

    await expect(
      appendLineChatTurn("U1", "hello", "hi"),
    ).resolves.toBeUndefined();
  });

  it("ignores malformed stored JSON", async () => {
    redisMock.get.mockResolvedValue("not-json");

    await expect(getLineChatHistory("U1")).resolves.toEqual([]);
  });
});
