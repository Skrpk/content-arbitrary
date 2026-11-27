import { z } from 'zod';
import type { SourceSuggestion, Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { telegramIdsOfMembers } from '@/lib/accounts/users';
import { track } from '@/lib/analytics/track';
import { activate, findSuggestion, removeSuggestion, suggestionsIn } from '@/lib/onboarding/activate-sources';
import { DIGEST_HOUR_DEFAULT } from '@/lib/onboarding/limits';
import type { OnboardingLanguage } from '@/lib/onboarding/messages';
import { publishingChannelPath } from '@/lib/publishing/codes';
import { buildReviewQueueUrl } from '@/lib/review/queue';
import type { TelegramClient } from '@/lib/telegram/client';
import { buildSettingsUrl } from '@/lib/telegram/commands';
import { escapeHtml, TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import { findWorkspaceById } from '@/lib/workspace';

/**
 * The "Стежу за" message (§23): the sources onboarding connected, each with
 * where it was found or why it fits, and ✕ to remove it; after a removal,
 * the best of the reserve with ➕. The message is edited in place as they change.
 */

const REASON_MAX = 140;

const WORDS = {
  uk: {
    header: (n: number, title: string) => `🚀 Стежу за ${n} ${plural(n, ['джерелом', 'джерелами', 'джерелами'])} для <b>${escapeHtml(title)}</b>:`,
    none: (title: string) => `Не вдалося автоматично знайти джерела для <b>${escapeHtml(title)}</b>.`,
    platform: { telegram: 'Telegram', youtube: 'YouTube', rss: 'сайт (RSS)', website: 'сайт', x: 'X', threads: 'Threads' },
    forwarded: (n: number) => `канал пересилав його ${n} ${plural(n, ['раз', 'рази', 'разів'])}`,
    linked: (n: number) => `канал посилався на нього ${n} ${plural(n, ['раз', 'рази', 'разів'])}`,
    digest: `Щоранку о ${DIGEST_HOUR_DEFAULT}:00 надсилатиму сюди дайджест — найкращі історії за добу. Усе інше буде в черзі.`,
    connect: 'Щоб публікувати пости прямо в канал, підключи його в Налаштуваннях (можна будь-коли).',
    fewer: 'Додай і свої джерела: /addtelegram @канал, /addyoutube @канал, /addrss посилання на RSS або /addwebsite посилання на sitemap.',
    instead: (name: string, platform: string, why: string) =>
      `Замість нього можу стежити за <b>${escapeHtml(name)}</b> (${platform})${why ? ` — ${escapeHtml(why)}` : ''}.`,
    removed: (name: string) => `Більше не стежу за ${name}.`,
    added: (name: string) => `Тепер стежу і за ${name}.`,
    add: (name: string) => `➕ Додати ${name}`,
    queue: '📋 Черга',
    profile: '📝 Профіль каналу',
    connectButton: '⚙️ Підключити канал',
    notYours: 'Це не твій канал.',
    gone: 'Цього джерела вже немає в списку.',
  },
  en: {
    header: (n: number, title: string) => `🚀 Following ${n} ${n === 1 ? 'source' : 'sources'} for <b>${escapeHtml(title)}</b>:`,
    none: (title: string) => `I couldn’t find sources for <b>${escapeHtml(title)}</b> on my own.`,
    platform: { telegram: 'Telegram', youtube: 'YouTube', rss: 'website (RSS)', website: 'website', x: 'X', threads: 'Threads' },
    forwarded: (n: number) => `the channel forwarded it ${n} ${n === 1 ? 'time' : 'times'}`,
    linked: (n: number) => `the channel linked to it ${n} ${n === 1 ? 'time' : 'times'}`,
    digest: `Every morning at ${DIGEST_HOUR_DEFAULT}:00 I’ll send a digest here — the day’s best stories. Everything else waits in the queue.`,
    connect: 'To publish straight to the channel, connect it in Settings (any time).',
    fewer: 'Add your own too: /addtelegram @channel, /addyoutube @channel, /addrss <feed URL> or /addwebsite <sitemap URL>.',
    instead: (name: string, platform: string, why: string) =>
      `Instead, I can follow <b>${escapeHtml(name)}</b> (${platform})${why ? ` — ${escapeHtml(why)}` : ''}.`,
    removed: (name: string) => `No longer following ${name}.`,
    added: (name: string) => `Now following ${name} too.`,
    add: (name: string) => `➕ Add ${name}`,
    queue: '📋 Queue',
    profile: '📝 Editorial profile',
    connectButton: '⚙️ Connect the channel',
    notYours: 'That isn’t your channel.',
    gone: 'That source is no longer on the list.',
  },
} as const;

function plural(n: number, forms: readonly [string, string, string]): string {
  const rule = new Intl.PluralRules('uk').select(n);
  return rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
}

function why(language: OnboardingLanguage, suggestion: SourceSuggestion): string {
  const words = WORDS[language];
  if (suggestion.forwards > 0) return words.forwarded(suggestion.forwards);
  if (suggestion.links > 0) return words.linked(suggestion.links);
  const reason = suggestion.reason?.trim() ?? '';
  return reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1).trimEnd()}…` : reason;
}

function nameOf(suggestion: SourceSuggestion): string {
  return suggestion.platform === 'telegram' && !suggestion.displayName.startsWith('@') && suggestion.displayName === suggestion.externalId
    ? `@${suggestion.externalId}`
    : suggestion.displayName;
}

export function followingText(
  language: OnboardingLanguage,
  input: { title: string; active: SourceSuggestion[]; offer?: SourceSuggestion | null; connected: boolean },
): string {
  const words = WORDS[language];
  const lines = input.active.map((suggestion, index) => {
    const reason = why(language, suggestion);
    return `${index + 1}. ${escapeHtml(nameOf(suggestion))} — ${words.platform[suggestion.platform]}${reason ? ` · ${escapeHtml(reason)}` : ''}`;
  });
  const parts = [
    input.active.length > 0 ? `${words.header(input.active.length, input.title)}\n${lines.join('\n')}` : words.none(input.title),
    ...(input.offer ? [words.instead(nameOf(input.offer), words.platform[input.offer.platform], why(language, input.offer))] : []),
    ...(input.active.length < 3 ? [words.fewer] : []),
    words.digest,
    ...(input.connected ? [] : [words.connect]),
  ];
  return parts.join('\n\n');
}

export function followingKeyboard(
  language: OnboardingLanguage,
  input: { workspaceId: number; active: SourceSuggestion[]; offer?: SourceSuggestion | null; appBaseUrl?: string; connected: boolean },
) {
  const words = WORDS[language];
  const remove = input.active.map((suggestion, index) => ({ text: `✕ ${index + 1}`, callback_data: `ob:rm:${suggestion.id}` }));
  const rows: unknown[][] = [];
  for (let start = 0; start < remove.length; start += 5) rows.push(remove.slice(start, start + 5));
  if (input.offer) rows.push([{ text: words.add(nameOf(input.offer)).slice(0, 60), callback_data: `ob:add:${input.offer.id}` }]);
  rows.push([{ text: words.profile, callback_data: `pf:s:${input.workspaceId}` }]);
  if (input.appBaseUrl) {
    rows.push([
      { text: words.queue, web_app: { url: buildReviewQueueUrl(input.appBaseUrl, input.workspaceId, undefined, 'sources') } },
      ...(input.connected
        ? []
        : [{ text: words.connectButton, web_app: { url: publishingChannelPath(buildSettingsUrl(input.appBaseUrl)) } }]),
    ]);
  }
  return { inline_keyboard: rows };
}

/** What the message shows now, for a workspace. */
export async function followingView(
  db: Database,
  workspace: Pick<Workspace, 'id' | 'name' | 'channelVerifiedAt'>,
  language: OnboardingLanguage,
  input: { offer?: SourceSuggestion | null; appBaseUrl?: string },
) {
  const active = await suggestionsIn(db, workspace.id, ['active']);
  const connected = workspace.channelVerifiedAt !== null;
  return {
    text: followingText(language, { title: workspace.name, active, offer: input.offer, connected }),
    keyboard: followingKeyboard(language, { workspaceId: workspace.id, active, offer: input.offer, appBaseUrl: input.appBaseUrl, connected }),
  };
}

export const onboardingCallbackSchema = z.object({
  id: z.string(),
  from: z.object({ id: z.number(), language_code: z.string().optional() }),
  data: z.string(),
  message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
});

/**
 * ✕ and ➕ under the message. Only someone who reviews the suggestion's
 * workspace may press them; the message is edited to what is now followed.
 */
export async function handleOnboardingCallback(
  query: z.infer<typeof onboardingCallbackSchema>,
  context: { db: Database; client: Pick<TelegramClient, 'answerCallbackQuery' | 'editMessageText' | 'call'>; logger: Logger; appBaseUrl?: string },
): Promise<void> {
  const { db, client, logger } = context;
  const language: OnboardingLanguage = query.from.language_code?.toLowerCase().startsWith('uk') ? 'uk' : 'en';
  const words = WORDS[language];
  const match = /^ob:(rm|add):(\d{1,12})$/.exec(query.data);
  const suggestion = match ? await findSuggestion(db, Number(match[2])) : null;
  const workspace = suggestion ? await findWorkspaceById(db, suggestion.workspaceId) : null;
  if (!match || !suggestion || !workspace) {
    await client.answerCallbackQuery(query.id, words.gone).catch(() => {});
    return;
  }
  const reviewers = new Set([workspace.telegramAdminChatId, ...(await telegramIdsOfMembers(db, workspace.id))]);
  if (!reviewers.has(String(query.from.id))) {
    logger.warn('onboarding.callback_refused', { fromId: query.from.id, suggestionId: suggestion.id });
    await client.answerCallbackQuery(query.id, words.notYours).catch(() => {});
    return;
  }

  let offer: SourceSuggestion | null = null;
  let notice: string;
  if (match[1] === 'rm') {
    const removed = await removeSuggestion(db, { suggestionId: suggestion.id });
    if (!removed) {
      await client.answerCallbackQuery(query.id, words.gone).catch(() => {});
      return;
    }
    offer = removed.offer;
    notice = words.removed(nameOf(removed.removed));
    logger.info('onboarding.source_removed', { workspaceId: workspace.id, suggestionId: suggestion.id, origin: suggestion.origin });
    await track(db, 'source.removed', { telegramUserId: query.from.id, workspaceId: workspace.id, props: { origin: suggestion.origin, platform: suggestion.platform, offered: offer !== null } }, logger);
  } else {
    if (suggestion.state !== 'reserve') {
      await client.answerCallbackQuery(query.id, words.gone).catch(() => {});
      return;
    }
    const added = await activate(db, suggestion, logger);
    notice = words.added(nameOf(added));
    logger.info('onboarding.source_replaced', { workspaceId: workspace.id, suggestionId: suggestion.id, origin: suggestion.origin });
    await track(db, 'source.replaced', { telegramUserId: query.from.id, workspaceId: workspace.id, props: { origin: suggestion.origin, platform: suggestion.platform, ok: added.state === 'active' } }, logger);
  }

  await client.answerCallbackQuery(query.id, notice).catch(() => {});
  if (!query.message) return;
  const view = await followingView(db, workspace, language, { offer, appBaseUrl: context.appBaseUrl });
  await client
    .editMessageText(String(query.message.chat.id), query.message.message_id, view.text, TELEGRAM_PARSE_MODE, view.keyboard as never)
    .catch((error: unknown) => logger.warn('onboarding.following_edit_failed', { error: describeError(error) }));
}
