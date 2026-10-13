import { and, count, eq, gte } from 'drizzle-orm';
import type { Database } from '@/lib/db';
import type { Env } from '@/lib/env';
import { assistantRequests } from '@/db/schema';
import { createOpenAiAssistant, type AssistantModel } from '@/lib/assistant/openai';

/** Whether the editor offers the assistant: an OpenAI key, and a limit above zero. */
export function assistantAvailable(env: Pick<Env, 'OPENAI_API_KEY' | 'ASSISTANT_DAILY_LIMIT'>): boolean {
  return Boolean(env.OPENAI_API_KEY) && env.ASSISTANT_DAILY_LIMIT > 0;
}

/** The assistant's model, or null when it is not set up. */
export function createAssistantModel(
  env: Pick<Env, 'OPENAI_API_KEY' | 'ASSISTANT_DAILY_LIMIT' | 'ASSISTANT_MODEL'>,
): AssistantModel | null {
  return assistantAvailable(env) ? createOpenAiAssistant({ apiKey: env.OPENAI_API_KEY, model: env.ASSISTANT_MODEL }) : null;
}

/** How many requests a reviewer has made since `since` — what the daily limit counts. */
export async function countAssistantRequestsSince(db: Database, input: { userId: number; since: Date }): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(assistantRequests)
    .where(and(eq(assistantRequests.userId, input.userId), gte(assistantRequests.createdAt, input.since)));
  return row?.total ?? 0;
}

export async function insertAssistantRequest(db: Database, row: typeof assistantRequests.$inferInsert): Promise<void> {
  await db.insert(assistantRequests).values(row);
}
