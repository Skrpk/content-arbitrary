import { escapeHtml } from '@/lib/telegram/format-caption';

/**
 * What the bot says during onboarding, in Ukrainian for someone whose
 * Telegram is in Ukrainian and in English otherwise. HTML, as the bot sends it.
 */

export type OnboardingLanguage = 'uk' | 'en';

export function onboardingLanguage(languageCode: string | undefined | null): OnboardingLanguage {
  return languageCode?.toLowerCase().startsWith('uk') ? 'uk' : 'en';
}

const COPY = {
  uk: {
    welcome:
      '👋 Привіт! Я Змістик.\n\nНадішли мені публічний Telegram-канал, для якого ти робиш контент. Я проаналізую, що він публікує, сам знайду джерела й щоранку надсилатиму тобі найкраще, що варто взяти в роботу.\n\nФормат: <code>@channelname</code> або <code>https://t.me/channelname</code>',
    stillWaiting: 'Чекаю на твій канал: <code>@channelname</code> або <code>https://t.me/channelname</code>',
    notAChannel: 'Не можу прочитати цей канал. Перевір, що це публічний канал з @username.',
    privateChannel: 'Це посилання на приватний канал. Потрібен публічний канал з @username.',
    noPosts: 'У цьому каналі не знайшов жодного поста. Надішли канал, у якому вже є публікації.',
    tryAgainLater: 'Telegram зараз не відповідає. Спробуй надіслати канал ще раз за хвилину.',
    found: (title: string) => `✅ Знайшов <b>${escapeHtml(title)}</b>. Аналізую останні пости — зазвичай це пару хвилин.`,
    readHistory: (title: string, usable: number) =>
      `✅ <b>${escapeHtml(title)}</b>: прочитав останні ${usable} ${plural(usable, ['пост', 'пости', 'постів'])}. Розбираюся, про що канал…`,
    fewPosts: 'Постів небагато, тож рекомендації можуть бути менш точними.',
    profiled: (title: string, usable: number, topics: string[]) =>
      `✅ <b>${escapeHtml(title)}</b>: проаналізував останні ${usable} ${plural(usable, ['пост', 'пости', 'постів'])}.` +
      (topics.length > 0 ? `\n\nКанал переважно про:\n${topics.map((topic) => `• ${escapeHtml(topic)}`).join('\n')}` : ''),
    findingSources: '🔎 Шукаю джерела — це ще хвилина-дві.',
    retrying: 'Telegram обмежує запити — продовжу автоматично.',
    failed: 'Щось пішло не так під час аналізу каналу. Спробуй ще раз: /newchannel',
    busy: 'Я ще аналізую попередній канал. Напишу, щойно закінчу.',
    tooMany: (max: number) => `Можна підключити до ${max} каналів. Цей ліміт поки не змінюється.`,
    alreadyYours: (title: string) => `<b>${escapeHtml(title)}</b> уже підключено — оновлю його аналіз.`,
    settings: '⚙️ Налаштування',
  },
  en: {
    welcome:
      '👋 Hi! I’m Zmistik.\n\nSend me the public Telegram channel you make content for. I’ll learn what it publishes, find sources for it myself, and every morning send you the best of what’s worth picking up.\n\nFormat: <code>@channelname</code> or <code>https://t.me/channelname</code>',
    stillWaiting: 'Waiting for your channel: <code>@channelname</code> or <code>https://t.me/channelname</code>',
    notAChannel: 'I can’t read that channel. Check it’s a public channel with an @username.',
    privateChannel: 'That’s a link to a private channel. I need a public channel with an @username.',
    noPosts: 'That channel has no posts yet. Send one that has published something.',
    tryAgainLater: 'Telegram isn’t answering right now. Send the channel again in a minute.',
    found: (title: string) => `✅ Found <b>${escapeHtml(title)}</b>. Reading its latest posts — usually a couple of minutes.`,
    readHistory: (title: string, usable: number) =>
      `✅ <b>${escapeHtml(title)}</b>: read its latest ${usable} ${usable === 1 ? 'post' : 'posts'}. Working out what it’s about…`,
    fewPosts: 'There aren’t many posts, so recommendations may be less precise.',
    profiled: (title: string, usable: number, topics: string[]) =>
      `✅ <b>${escapeHtml(title)}</b>: analysed its latest ${usable} ${usable === 1 ? 'post' : 'posts'}.` +
      (topics.length > 0 ? `\n\nIt’s mostly about:\n${topics.map((topic) => `• ${escapeHtml(topic)}`).join('\n')}` : ''),
    findingSources: '🔎 Looking for sources — another minute or two.',
    retrying: 'Telegram is limiting requests — I’ll carry on automatically.',
    failed: 'Something went wrong analysing the channel. Try again: /newchannel',
    busy: 'I’m still analysing your previous channel. I’ll write as soon as I’m done.',
    tooMany: (max: number) => `You can connect up to ${max} channels for now.`,
    alreadyYours: (title: string) => `<b>${escapeHtml(title)}</b> is already connected — I’ll refresh its analysis.`,
    settings: '⚙️ Settings',
  },
} as const;

export function copy(language: OnboardingLanguage) {
  return COPY[language];
}

function plural(n: number, forms: readonly [string, string, string]): string {
  const rule = new Intl.PluralRules('uk').select(n);
  return rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
}
