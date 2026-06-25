import UserMemory, { type IUserMemory } from "../../model/user-memory.model";
import { redisGet, redisSet, redisDel } from "../../config/redis";

const CACHE_PREFIX = "user-mem:";
const CACHE_TTL_SEC = 300;
const MAX_MEMORIES_PER_USER = 50;

function cacheKey(userId: string): string {
  return CACHE_PREFIX + userId;
}

async function invalidateCache(userId: string): Promise<void> {
  await redisDel(cacheKey(userId));
}

/**
 * @param userId The authenticated user's ID.
 * @param limit Maximum number of memories to return (default 20).
 * @returns Memories ordered by updatedAt desc, served from Redis when warm.
 */
export async function loadMemories(
  userId: string,
  limit = 20,
): Promise<IUserMemory[]> {
  const cached = await redisGet(cacheKey(userId));
  if (cached) {
    const parsed = JSON.parse(cached) as IUserMemory[];
    return parsed.slice(0, limit);
  }

  const memories = await UserMemory.find({ userId })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  if (memories.length) {
    await redisSet(cacheKey(userId), JSON.stringify(memories), CACHE_TTL_SEC);
  }
  return memories as IUserMemory[];
}

/**
 * @param userId The authenticated user's ID.
 * @param content Natural-language memory content.
 * @param category The memory category.
 * @returns The saved or updated memory document.
 */
export async function saveMemory(
  userId: string,
  content: string,
  category: IUserMemory["category"],
): Promise<IUserMemory> {
  const existing = await UserMemory.findOne({ userId, category, content }).lean();
  if (existing) {
    const updated = await UserMemory.findByIdAndUpdate(
      existing._id,
      { $set: { content, updatedAt: new Date() } },
      { new: true },
    ).lean();
    await invalidateCache(userId);
    return updated as IUserMemory;
  }

  const doc = await UserMemory.create({ userId, content, category });

  const count = await UserMemory.countDocuments({ userId });
  if (count > MAX_MEMORIES_PER_USER) {
    const oldest = await UserMemory.find({ userId })
      .sort({ updatedAt: 1 })
      .limit(count - MAX_MEMORIES_PER_USER)
      .select("_id");
    await UserMemory.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
  }

  await invalidateCache(userId);
  return doc.toObject() as IUserMemory;
}

/**
 * @param userId The authenticated user's ID.
 * @param memoryId The memory document's _id to delete.
 * @returns True if deleted, false if not found or not owned.
 */
export async function deleteMemory(
  userId: string,
  memoryId: string,
): Promise<boolean> {
  const result = await UserMemory.deleteOne({ _id: memoryId, userId });
  if (result.deletedCount > 0) {
    await invalidateCache(userId);
    return true;
  }
  return false;
}
