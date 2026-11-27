import { after } from 'next/server';
import { z } from 'zod';
import type { Workspace } from '@/db/schema';
import type { Database } from '@/lib/db';
import { describeError } from '@/lib/errors';
import type { Logger } from '@/lib/logger';
import { onboardingLanguage, type OnboardingLanguage } from '@/lib/onboarding/messages';
import { refineProfile } from '@/lib/profile/refine-profile';
import { EDITORIAL_PROFILE_MAX_LENGTH, editorialProfileLength } from '@/lib/radar/editorial-profile';
import type { RadarProvider } from '@/lib/radar/providers/types';
import type { TelegramClient } from '@/lib/telegram/client';
import { escapeHtml, TELEGRAM_PARSE_MODE } from '@/lib/telegram/format-caption';
import { awaitInput, clearPendingInput, pendingInputOf } from '@/lib/telegram/pending-input';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from '@/lib/telegram/send-media';
import { findWorkspaceById, findWorkspacesByAdminChatId, setEditorialProfile, setWorkspaceLanguage } from '@/lib/workspace';
import { languageLabel, normaliseLanguageCode } from '@/lib/workspace-language';

/**
 * The editorial profile in the bot's chat (§14a): /profile shows it, with
 * ✏️ to replace it with the next message, 💬 to have the model rewrite it
 * from an instruction (saved only on ✅), and 🌐 to set the language posts go
 * out in. Every save is the editor's (`editorial_profile_source = 'editor'`),
 * and Radar scores the next post with it.
 *
 * Buttons carry `pf:<action>:<workspace>`; each press is checked against the
 * presser's own channels, like every other callback.
 */

const WORDS = {
  uk: {
    title: (name: string) => `📝 <b>Профіль каналу ${escapeHtml(name)}</b>`,
    auto: ' (згенерований автоматично)',
    empty: '<i>Профілю ще немає — без нього Radar не оцінює пости.</i>',
    language: (label: string) => `Мова постів: ${label}`,
    asIs: 'як у джерелах, без перекладу',
    replace: '✏️ Написати свій',
    refine: '💬 Уточнити',
    languageButton: '🌐 Мова',
    settings: '⚙️ Налаштування',
    which: 'Профіль якого каналу?',
    askReplace: `Надішли новий текст профілю одним повідомленням (до ${EDITORIAL_PROFILE_MAX_LENGTH} символів).`,
    askRefine: 'Напиши, що змінити — наприклад: «більше про інді-ігри, без знижок і розіграшів».',
    askMore: 'Напиши, що ще змінити в цьому варіанті.',
    askLanguage: 'Надішли код мови, наприклад de, pl або pt-BR.',
    tooLong: (over: number) => `Задовго на ${over} ${plural(over, ['символ', 'символи', 'символів'])} — скороти й надішли ще раз.`,
    saved: 'Збережено. Нові пости оцінюватиму за оновленим профілем.',
    refining: '⏳ Переписую профіль…',
    draft: (text: string) => `Ось новий варіант:\n\n${text}\n\nЗберегти?`,
    save: '✅ Зберегти',
    cancel: '↩️ Скасувати',
    more: '💬 Ще уточнити',
    cancelled: 'Скасовано.',
    refineFailed: 'Не вийшло переписати профіль — надішли інструкцію ще раз.',
    noModel: 'Переписувати профіль зараз нікому — напиши свій через ✏️.',
    stale: 'Ця чернетка вже неактуальна — уточни ще раз.',
    unknownLanguage: 'Не знаю такої мови. Надішли код, наприклад de, pl або pt-BR.',
    languageSet: (label: string) => `Мову змінено: ${label}. Діє для нових постів.`,
    other: 'Інша…',
    back: '↩️ Назад',
    notYours: 'Це не твій канал.',
  },
  en: {
    title: (name: string) => `📝 <b>Editorial profile of ${escapeHtml(name)}</b>`,
    auto: ' (written automatically)',
    empty: '<i>No profile yet — without one Radar does not score posts.</i>',
    language: (label: string) => `Posts’ language: ${label}`,
    asIs: 'as the sources write, no translation',
    replace: '✏️ Write my own',
    refine: '💬 Refine',
    languageButton: '🌐 Language',
    settings: '⚙️ Settings',
    which: 'The profile of which channel?',
    askReplace: `Send the new profile as one message (up to ${EDITORIAL_PROFILE_MAX_LENGTH} characters).`,
    askRefine: 'Say what to change — for example: “more indie games, no discounts or giveaways”.',
    askMore: 'Say what else to change in this version.',
    askLanguage: 'Send the language’s code, for example de, pl or pt-BR.',
    tooLong: (over: number) => `${over} ${over === 1 ? 'character' : 'characters'} too long — shorten it and send it again.`,
    saved: 'Saved. New posts are scored with the updated profile.',
    refining: '⏳ Rewriting the profile…',
    draft: (text: string) => `Here is the new version:\n\n${text}\n\nSave it?`,
    save: '✅ Save',
    cancel: '↩️ Cancel',
    more: '💬 Refine more',
    cancelled: 'Cancelled.',
    refineFailed: 'Could not rewrite the profile — send the instruction again.',
    noModel: 'Nothing can rewrite the profile right now — write your own with ✏️.',
    stale: 'That draft is out of date — refine it again.',
    unknownLanguage: 'I don’t know that language. Send a code, for example de, pl or pt-BR.',
    languageSet: (label: string) => `Language changed: ${label}. It applies to new posts.`,
    other: 'Other…',
    back: '↩️ Back',
    notYours: 'That isn’t your channel.',
  },
} as const;

/** The languages offered as buttons; any other is typed. */
const OFFERED_LANGUAGES = ['uk', 'en'] as const;

/** Under Telegram's 4,096 characters, whatever escaping does to the profile. */
const MESSAGE_MAX = 4000;

function plural(n: number, forms: readonly [string, string, string]): string {
  const rule = new Intl.PluralRules('uk').select(n);
  return rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
}

function fit(text: string): string {
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;
}

export function postsLanguageLabel(language: string | null, botLanguage: OnboardingLanguage): string {
  return language === null ? WORDS[botLanguage].asIs : languageLabel(language, botLanguage);
}

type ProfileWorkspace = Pick<Workspace, 'id' | 'name' | 'editorialProfile' | 'editorialProfileSource' | 'language'>;

export function profileScreenText(workspace: ProfileWorkspace, language: OnboardingLanguage, notice?: string): string {
  const words = WORDS[language];
  const auto = workspace.editorialProfile !== null && workspace.editorialProfileSource === 'auto' ? words.auto : '';
  return fit(
    [
      ...(notice ? [notice] : []),
      `${words.title(workspace.name)}${auto}`,
      workspace.editorialProfile === null ? words.empty : escapeHtml(workspace.editorialProfile),
      words.language(escapeHtml(postsLanguageLabel(workspace.language, language))),
    ].join('\n\n'),
  );
}

export function profileScreenKeyboard(
  workspace: Pick<Workspace, 'id' | 'editorialProfile'>,
  language: OnboardingLanguage,
  settingsUrl?: string,
): InlineKeyboardMarkup {
  const words = WORDS[language];
  return {
    inline_keyboard: [
      [
        { text: words.replace, callback_data: `pf:e:${workspace.id}` },
        // Nothing to refine without a profile; the model would be writing one from a sentence.
        ...(workspace.editorialProfile !== null ? [{ text: words.refine, callback_data: `pf:r:${workspace.id}` }] : []),
      ],
      [
        { text: words.languageButton, callback_data: `pf:l:${workspace.id}` },
        ...(settingsUrl ? [{ text: words.settings, web_app: { url: settingsUrl } } as InlineKeyboardButton] : []),
      ],
    ],
  };
}

function languageKeyboard(workspaceId: number, language: OnboardingLanguage): InlineKeyboardMarkup {
  const words = WORDS[language];
  return {
    inline_keyboard: [
      OFFERED_LANGUAGES.map((code) => ({ text: languageLabel(code, code), callback_data: `pf:L:${workspaceId}:${code}` })),
      [
        { text: words.asIs, callback_data: `pf:L:${workspaceId}:-` },
        { text: words.other, callback_data: `pf:o:${workspaceId}` },
      ],
      [{ text: words.back, callback_data: `pf:x:${workspaceId}` }],
    ],
  };
}

function draftKeyboard(workspaceId: number, language: OnboardingLanguage): InlineKeyboardMarkup {
  const words = WORDS[language];
  return {
    inline_keyboard: [
      [
        { text: words.save, callback_data: `pf:ok:${workspaceId}` },
        { text: words.cancel, callback_data: `pf:x:${workspaceId}` },
      ],
      [{ text: words.more, callback_data: `pf:m:${workspaceId}` }],
    ],
  };
}

function cancelKeyboard(workspaceId: number, language: OnboardingLanguage): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: WORDS[language].cancel, callback_data: `pf:x:${workspaceId}` }]] };
}

export interface ProfileContext {
  db: Database;
  client: Pick<TelegramClient, 'call' | 'answerCallbackQuery' | 'editMessageText'>;
  logger: Logger;
  /** The settings Mini App, for the ⚙️ button; none without a Mini App. */
  settingsUrl?: string;
  /** Rewrites for 💬; null with no model configured. */
  provider: RadarProvider | null;
  /** Runs the rewrite once the webhook has answered; inline outside a request (and in tests). */
  defer?: (task: () => Promise<void>) => Promise<void>;
}

/** After the response when there is one, so a slow model never holds Telegram's webhook; inline otherwise. */
async function deferByDefault(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}

async function send(context: Pick<ProfileContext, 'client' | 'logger'>, chatId: string, text: string, markup?: InlineKeyboardMarkup) {
  try {
    const sent = await context.client.call(
      'sendMessage',
      {
        chat_id: chatId,
        text,
        parse_mode: TELEGRAM_PARSE_MODE,
        link_preview_options: { is_disabled: true },
        ...(markup ? { reply_markup: markup } : {}),
      },
      z.object({ message_id: z.number() }),
    );
    return sent.message_id;
  } catch (error) {
    context.logger.warn('profile.message_failed', { error: describeError(error) });
    return null;
  }
}

async function edit(
  context: Pick<ProfileContext, 'client' | 'logger'>,
  chatId: string,
  messageId: number,
  text: string,
  markup?: InlineKeyboardMarkup,
): Promise<void> {
  await context.client.editMessageText(chatId, messageId, text, TELEGRAM_PARSE_MODE, markup).catch((error: unknown) => {
    const message = describeError(error);
    if (!/message is not modified/i.test(message)) context.logger.warn('profile.edit_failed', { error: message });
  });
}

/**
 * /profile: the screen for the one channel the sender reviews, or a button
 * per channel to choose from.
 */
export async function profileCommandReply(input: {
  db: Database;
  /** The channels the sender reviews, as the webhook found them. */
  workspaceIds: number[];
  languageCode?: string;
  settingsUrl?: string;
}): Promise<{ text: string; replyMarkup: InlineKeyboardMarkup } | null> {
  const language = onboardingLanguage(input.languageCode);
  const workspaces = (await Promise.all(input.workspaceIds.map((id) => findWorkspaceById(input.db, id)))).filter(
    (workspace): workspace is Workspace => workspace !== null,
  );
  if (workspaces.length === 0) return null;
  if (workspaces.length === 1) {
    const workspace = workspaces[0]!;
    return { text: profileScreenText(workspace, language), replyMarkup: profileScreenKeyboard(workspace, language, input.settingsUrl) };
  }
  return {
    text: WORDS[language].which,
    replyMarkup: {
      inline_keyboard: workspaces.map((workspace) => [{ text: `📢 ${workspace.name}`.slice(0, 64), callback_data: `pf:s:${workspace.id}` }]),
    },
  };
}

export const profileCallbackSchema = z.object({
  id: z.string(),
  from: z.object({ id: z.number(), language_code: z.string().optional() }),
  data: z.string(),
  message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
});

const CALLBACK_PATTERN = /^pf:(s|e|r|m|ok|x|l|o|L):(\d{1,12})(?::([A-Za-z0-9-]{1,35}))?$/;

/** A press on one of the profile screen's buttons. */
export async function handleProfileCallback(query: z.infer<typeof profileCallbackSchema>, context: ProfileContext): Promise<void> {
  const { db } = context;
  const language = onboardingLanguage(query.from.language_code);
  const words = WORDS[language];
  const telegramUserId = String(query.from.id);
  const logger = context.logger.child({ fromId: query.from.id, surface: 'profile' });
  const answer = (text?: string) => context.client.answerCallbackQuery(query.id, text).catch(() => {});

  const match = CALLBACK_PATTERN.exec(query.data);
  const mine = await findWorkspacesByAdminChatId(db, telegramUserId);
  const workspace = match ? mine.find((candidate) => candidate.id === Number(match[2])) : undefined;
  if (!match || !workspace) {
    logger.warn('profile.callback_refused', { data: query.data });
    await answer(words.notYours);
    return;
  }
  const action = match[1]!;
  const chatId = query.message ? String(query.message.chat.id) : telegramUserId;
  const messageId = query.message?.message_id;
  const reviewerWorkspaceIds = mine.map((candidate) => candidate.id);
  const screen = (current: ProfileWorkspace, notice?: string) => ({
    text: profileScreenText(current, language, notice),
    markup: profileScreenKeyboard(current, language, context.settingsUrl),
  });
  /** Show the screen in place of the pressed message, or as a new one. */
  const showScreen = async (current: ProfileWorkspace, notice?: string) => {
    const view = screen(current, notice);
    if (messageId === undefined) await send(context, chatId, view.text, view.markup);
    else await edit(context, chatId, messageId, view.text, view.markup);
  };

  switch (action) {
    case 's': {
      await answer();
      const view = screen(workspace);
      await send(context, chatId, view.text, view.markup);
      return;
    }
    case 'e': {
      await awaitInput(db, { telegramUserId, kind: 'profile_replace', workspaceId: workspace.id });
      await answer();
      await send(context, chatId, words.askReplace, cancelKeyboard(workspace.id, language));
      return;
    }
    case 'r': {
      if (workspace.editorialProfile === null) {
        await answer();
        return;
      }
      await awaitInput(db, { telegramUserId, kind: 'profile_refine', workspaceId: workspace.id });
      await answer();
      await send(context, chatId, words.askRefine, cancelKeyboard(workspace.id, language));
      return;
    }
    case 'm': {
      // Refine the draft further: the next instruction applies to it, not to the saved profile.
      const pending = await pendingInputOf(db, telegramUserId);
      if (!pending || pending.kind !== 'profile_refine' || pending.workspaceId !== workspace.id || !pending.payload.draft) {
        await answer(words.stale);
        return;
      }
      await awaitInput(db, { telegramUserId, kind: 'profile_refine', workspaceId: workspace.id, payload: pending.payload });
      await answer();
      await send(context, chatId, words.askMore, cancelKeyboard(workspace.id, language));
      return;
    }
    case 'ok': {
      const pending = await pendingInputOf(db, telegramUserId);
      const draft = pending?.kind === 'profile_refine' && pending.workspaceId === workspace.id ? pending.payload.draft : undefined;
      if (!draft) {
        await answer(words.stale);
        return;
      }
      const updated = await setEditorialProfile(db, { workspaceId: workspace.id, reviewerWorkspaceIds, editorialProfile: draft });
      await clearPendingInput(db, telegramUserId);
      logger.info('profile.saved', { workspaceId: workspace.id, via: 'refine', length: editorialProfileLength(draft) });
      await answer(words.saved);
      await showScreen(updated ?? workspace, `✅ ${words.saved}`);
      return;
    }
    case 'x': {
      await clearPendingInput(db, telegramUserId);
      await answer(words.cancelled);
      await showScreen(workspace);
      return;
    }
    case 'l': {
      await answer();
      if (messageId === undefined) await send(context, chatId, profileScreenText(workspace, language), languageKeyboard(workspace.id, language));
      else await edit(context, chatId, messageId, profileScreenText(workspace, language), languageKeyboard(workspace.id, language));
      return;
    }
    case 'o': {
      await awaitInput(db, { telegramUserId, kind: 'language_custom', workspaceId: workspace.id });
      await answer();
      await send(context, chatId, words.askLanguage, cancelKeyboard(workspace.id, language));
      return;
    }
    case 'L': {
      const chosen = match[3] === '-' ? null : normaliseLanguageCode(match[3] ?? '');
      if (match[3] !== '-' && chosen === null) {
        await answer(words.unknownLanguage);
        return;
      }
      const updated = await setWorkspaceLanguage(db, { workspaceId: workspace.id, reviewerWorkspaceIds, language: chosen });
      logger.info('profile.language_set', { workspaceId: workspace.id, language: chosen });
      const label = postsLanguageLabel(chosen, language);
      await answer(words.languageSet(label));
      await showScreen(updated ?? workspace, `✅ ${escapeHtml(words.languageSet(label))}`);
      return;
    }
  }
}

export interface PendingInputMessage {
  chat: { id: number; type?: string };
  from?: { id: number; language_code?: string };
  text?: string;
}

/**
 * A private message while the bot waits for one (§14a): the new profile, an
 * instruction to rewrite it, or a language code. Returns whether it was one.
 * A /command is never an input: it cancels the wait and runs as usual.
 */
export async function handlePendingInputMessage(message: PendingInputMessage, context: ProfileContext): Promise<boolean> {
  const { db } = context;
  if (message.chat.type !== 'private' || !message.from) return false;
  const telegramUserId = String(message.from.id);
  const pending = await pendingInputOf(db, telegramUserId);
  if (!pending) return false;

  const text = message.text?.trim() ?? '';
  if (text.startsWith('/')) {
    await clearPendingInput(db, telegramUserId);
    return false;
  }

  const language = onboardingLanguage(message.from.language_code);
  const words = WORDS[language];
  const chatId = String(message.chat.id);
  const logger = context.logger.child({ fromId: message.from.id, surface: 'profile' });

  // Their channels now: one they no longer review is not theirs to change.
  const mine = await findWorkspacesByAdminChatId(db, telegramUserId);
  const workspace = mine.find((candidate) => candidate.id === pending.workspaceId);
  if (!workspace) {
    await clearPendingInput(db, telegramUserId);
    return false;
  }
  // A photo or a sticker: still waiting for the text.
  if (text === '') {
    await send(context, chatId, pending.kind === 'language_custom' ? words.askLanguage : words.askReplace);
    return true;
  }
  const reviewerWorkspaceIds = mine.map((candidate) => candidate.id);

  if (pending.kind === 'profile_replace') {
    const over = editorialProfileLength(text) - EDITORIAL_PROFILE_MAX_LENGTH;
    if (over > 0) {
      await send(context, chatId, words.tooLong(over), cancelKeyboard(workspace.id, language));
      return true;
    }
    const updated = await setEditorialProfile(db, { workspaceId: workspace.id, reviewerWorkspaceIds, editorialProfile: text });
    await clearPendingInput(db, telegramUserId);
    logger.info('profile.saved', { workspaceId: workspace.id, via: 'replace', length: editorialProfileLength(text) });
    const current = updated ?? workspace;
    await send(context, chatId, profileScreenText(current, language, `✅ ${words.saved}`), profileScreenKeyboard(current, language, context.settingsUrl));
    return true;
  }

  if (pending.kind === 'language_custom') {
    const code = normaliseLanguageCode(text);
    if (code === null) {
      await send(context, chatId, words.unknownLanguage, cancelKeyboard(workspace.id, language));
      return true;
    }
    const updated = await setWorkspaceLanguage(db, { workspaceId: workspace.id, reviewerWorkspaceIds, language: code });
    await clearPendingInput(db, telegramUserId);
    logger.info('profile.language_set', { workspaceId: workspace.id, language: code });
    const current = updated ?? workspace;
    const notice = `✅ ${escapeHtml(words.languageSet(postsLanguageLabel(code, language)))}`;
    await send(context, chatId, profileScreenText(current, language, notice), profileScreenKeyboard(current, language, context.settingsUrl));
    return true;
  }

  // profile_refine: rewrite the draft when there is one, else the saved profile.
  const provider = context.provider;
  if (!provider) {
    await clearPendingInput(db, telegramUserId);
    await send(context, chatId, words.noModel);
    return true;
  }
  const base = pending.payload.draft ?? workspace.editorialProfile;
  const instruction = Array.from(text).slice(0, EDITORIAL_PROFILE_MAX_LENGTH).join('');
  const progressId = await send(context, chatId, words.refining);
  const show = async (body: string, markup?: InlineKeyboardMarkup) => {
    if (progressId === null) await send(context, chatId, body, markup);
    else await edit(context, chatId, progressId, body, markup);
  };

  await (context.defer ?? deferByDefault)(async () => {
    let draft: string;
    try {
      ({ editorialProfile: draft } = await refineProfile({ provider, channelName: workspace.name, profile: base, instruction }));
    } catch (error) {
      logger.warn('profile.refine_failed', { workspaceId: workspace.id, error: describeError(error) });
      await show(words.refineFailed, cancelKeyboard(workspace.id, language));
      return;
    }
    // Cancelled, or another prompt pressed, while the model wrote: this draft is no one's now.
    const still = await pendingInputOf(db, telegramUserId);
    if (!still || still.kind !== 'profile_refine' || still.workspaceId !== workspace.id || draft === '') {
      await show(words.stale);
      return;
    }
    await awaitInput(db, { telegramUserId, kind: 'profile_refine', workspaceId: workspace.id, payload: { draft } });
    logger.info('profile.refined', { workspaceId: workspace.id, length: editorialProfileLength(draft) });
    await show(fit(words.draft(escapeHtml(draft))), draftKeyboard(workspace.id, language));
  });
  return true;
}
