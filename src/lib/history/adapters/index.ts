import { telegramJsonAdapter } from '@/lib/history/adapters/telegram-json';
import type { PublicationHistoryAdapter } from '@/lib/history/types';

/** Every export format the importer reads. A new format is one more entry. */
export const HISTORY_ADAPTERS: readonly PublicationHistoryAdapter[] = [telegramJsonAdapter];

export function historyAdapter(type: string): PublicationHistoryAdapter | undefined {
  return HISTORY_ADAPTERS.find((adapter) => adapter.type === type);
}
