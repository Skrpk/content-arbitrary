import type { Locale } from './i18n';

/**
 * Every word on the public site, per language.
 *
 * Everything claimed here is something the bot does today — the review
 * buttons in the mock-up are the real ones, and stay in English in both
 * languages because that is how the bot shows them. Keep it that way: a
 * feature belongs here once it ships, not before, and in every language at
 * once.
 */

interface Item {
  title: string;
  text: string;
}

export interface LandingContent {
  meta: { title: string; description: string; ogHeadline: string; ogSubline: string };
  nav: { features: string; howItWorks: string; faq: string; home: string; main: string };
  skipLink: string;
  connect: string;
  languageSwitch: { label: string; names: Record<Locale, string> };
  hero: { eyebrow: string; title: string; lead: string; primary: string; secondary: string };
  mockup: { label: string; text: string; caption: string };
  features: { title: string; lead: string; items: (Item & { icon: string })[] };
  steps: { title: string; lead: string; items: Item[] };
  audiences: { title: string; items: Item[] };
  faq: { title: string; items: { question: string; answer: string }[] };
  cta: { title: string; text: string; button: string };
  footer: { disclaimer: string; contact: string };
}

const en: LandingContent = {
  meta: {
    title: 'Auto-post from X (Twitter) to your Telegram channel, with moderation',
    description:
      'A Telegram bot that brings new posts from X (Twitter) into your Telegram channel — ' +
      'photos, videos, albums and long posts. Approve, edit, reject and schedule them right ' +
      'in Telegram.',
    ogHeadline: 'Auto-post from X to your Telegram channel',
    ogSubline: 'Approve, edit and schedule posts right in Telegram',
  },
  nav: {
    features: 'Features',
    howItWorks: 'How it works',
    faq: 'FAQ',
    home: 'home',
    main: 'Main navigation',
  },
  skipLink: 'Skip to content',
  connect: 'Get started',
  languageSwitch: { label: 'Language', names: { en: 'EN', uk: 'UK' } },
  hero: {
    eyebrow: 'A Telegram bot for channel admins',
    title: 'Auto-post from X (Twitter) to your Telegram channel — with moderation',
    lead:
      'The bot follows the X accounts you pick and sends their new photo and video posts to ' +
      'you for review. Approve, edit, reject or schedule — and the post appears in your ' +
      'channel. All inside Telegram.',
    primary: 'Connect your channel',
    secondary: 'How it works',
  },
  mockup: {
    label: 'How a post arrives for review in Telegram',
    text: 'First images from the new mission: the probe sent back record-resolution shots of the surface.',
    caption: 'A new post in your chat with the bot — before it reaches the channel.',
  },
  features: {
    title: 'Everything you need to run a channel on X content',
    lead: 'No copying by hand, no re-uploading videos, no hunting for what you already posted.',
    items: [
      {
        icon: '🖼',
        title: 'Photos, videos and albums',
        text: 'A post with several photos or videos arrives as one album, just like the original. Videos come in the best quality Telegram accepts.',
      },
      {
        icon: '✅',
        title: 'Review before publishing',
        text: 'Every new post comes to you in the bot first. Approve it and it goes to the channel. Nothing is published without your say.',
      },
      {
        icon: '✏️',
        title: 'Edit the text',
        text: 'Rewrite the caption for your channel right in Telegram, in a built-in editor with a character counter. The media stays as it is.',
      },
      {
        icon: '🕒',
        title: 'Scheduled publishing',
        text: 'Pick a date and time and the post goes out that minute. Move the time, publish it early, or send it back to review.',
      },
      {
        icon: '📚',
        title: 'Several X accounts at once',
        text: 'Follow several sources for one channel. Add, pause and remove them with a single command in the bot.',
      },
      {
        icon: '📝',
        title: 'Long posts in full',
        text: 'A long X post is published whole: the caption under the media, and the full text as a follow-up message when it does not fit.',
      },
      {
        icon: '🔗',
        title: 'Link to the source',
        text: 'Every post links back to the original on X. Reposts and replies are skipped, so only the author’s own posts reach your channel.',
      },
      {
        icon: '🛡',
        title: 'No duplicates',
        text: 'The bot remembers every post it has published. A double tap or two overlapping runs will not publish it twice.',
      },
    ],
  },
  steps: {
    title: 'How it works',
    lead: 'Setup takes a few minutes and needs no code.',
    items: [
      { title: 'Get in touch', text: 'We connect your channel and set you up as its moderator.' },
      { title: 'Add the bot to your channel', text: 'Make the bot an admin of your Telegram channel with the right to post.' },
      { title: 'Pick X accounts', text: 'Send the bot /addsource @username and it starts following that account.' },
      {
        title: 'Review and publish',
        text: 'New posts arrive in the bot exactly as they will look in the channel. Tap Approve and it is published.',
      },
    ],
  },
  audiences: {
    title: 'Who it is for',
    items: [
      {
        title: 'News and niche channels',
        text: 'Bring in posts from the key accounts in your niche fast, and keep only the editorial work for yourself.',
      },
      {
        title: 'Admins short on time',
        text: 'Instead of copying text and re-uploading media by hand — one tap per post.',
      },
      {
        title: 'Channel networks',
        text: 'One service for several channels, each with its own sources and its own moderator.',
      },
    ],
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      {
        question: 'Do I need my own X API access?',
        answer:
          'No. X access is on our side. All you need is a Telegram channel and the bot added to it as an admin.',
      },
      {
        question: 'How fast does a new post reach my channel?',
        answer:
          'The bot checks the accounts every hour and sends new posts to you for review right away. A post goes to the channel as soon as you tap Approve — or at the time you scheduled.',
      },
      {
        question: 'Which posts are brought over?',
        answer:
          'Posts with photos and videos, including albums and long posts. Posts without media can be switched on for each account separately. Reposts and replies are skipped.',
      },
      {
        question: 'Can I follow private accounts?',
        answer: 'No. The service works with public X accounts only.',
      },
      {
        question: 'Will a scheduled post show up in the channel’s “Scheduled messages”?',
        answer:
          'No — Telegram does not let bots use that list. The bot keeps the schedule itself and publishes the post within a minute of the chosen time. /scheduled lists what is waiting.',
      },
      {
        question: 'What happens when I reject a post?',
        answer:
          'It never reaches the channel and does not come back. The bot asks you to pick a reason or write your own — over time that shows which posts your channel does not need.',
      },
      {
        question: 'How much does it cost?',
        answer:
          'It depends on how many channels and accounts you need. Message us on Telegram and we will find the right option.',
      },
    ],
  },
  cta: {
    title: 'Connect your channel',
    text: 'Message us on Telegram — we will help you set up the bot and choose accounts to follow.',
    button: 'Message us on Telegram',
  },
  footer: {
    disclaimer:
      'X is a trademark of X Corp. Telegram is a trademark of Telegram FZ-LLC. This service is not affiliated with either.',
    contact: 'Contact us on Telegram',
  },
};

const uk: LandingContent = {
  meta: {
    title: 'Автопостинг з X (Twitter) у Telegram-канал з модерацією',
    description:
      'Telegram-бот, який автоматично переносить нові пости з X (Twitter) у ваш Telegram-канал: ' +
      'фото, відео, альбоми й довгі тексти. Погоджуйте, редагуйте, відхиляйте та плануйте ' +
      'публікації прямо в Telegram.',
    ogHeadline: 'Автопостинг з X у Telegram-канал',
    ogSubline: 'Погоджуйте, редагуйте й плануйте пости прямо в Telegram',
  },
  nav: {
    features: 'Можливості',
    howItWorks: 'Як це працює',
    faq: 'Питання',
    home: 'на головну',
    main: 'Основна навігація',
  },
  skipLink: 'Перейти до змісту',
  connect: 'Підключити',
  languageSwitch: { label: 'Мова', names: { en: 'EN', uk: 'UK' } },
  hero: {
    eyebrow: 'Telegram-бот для адмінів каналів',
    title: 'Автопостинг з X (Twitter) у ваш Telegram-канал — з модерацією',
    lead:
      'Бот стежить за обраними акаунтами в X і надсилає нові пости з фото й відео вам на ' +
      'погодження. Затвердіть, відредагуйте, відхиліть чи заплануйте — і пост з’явиться в ' +
      'каналі. Усе прямо в Telegram.',
    primary: 'Підключити канал',
    secondary: 'Як це працює',
  },
  mockup: {
    label: 'Так пост приходить на погодження в Telegram',
    text: 'Перші кадри з нової місії: зонд передав знімки поверхні з рекордною роздільністю.',
    caption: 'Новий пост у вашому чаті з ботом — до публікації в каналі.',
  },
  features: {
    title: 'Усе, щоб вести канал на контенті з X',
    lead: 'Без ручного копіювання, перезавантаження відео й пошуку, що ви вже публікували.',
    items: [
      {
        icon: '🖼',
        title: 'Фото, відео й альбоми',
        text: 'Пост із кількома фото чи відео приходить одним альбомом, як в оригіналі. Відео — у найкращій якості, яку приймає Telegram.',
      },
      {
        icon: '✅',
        title: 'Модерація перед публікацією',
        text: 'Кожен новий пост спершу приходить вам у бот. Погодили — пішов у канал. Нічого не публікується без вашого рішення.',
      },
      {
        icon: '✏️',
        title: 'Редагування тексту',
        text: 'Перепишіть підпис під свій канал прямо в Telegram — у вбудованому редакторі з лічильником символів. Медіа лишається без змін.',
      },
      {
        icon: '🕒',
        title: 'Відкладена публікація',
        text: 'Оберіть дату й час — пост вийде в канал у цю хвилину. Час можна змінити, а пост — опублікувати раніше чи повернути на розгляд.',
      },
      {
        icon: '📚',
        title: 'Кілька акаунтів X одночасно',
        text: 'Стежте за кількома джерелами для одного каналу. Додавайте, ставте на паузу й прибирайте їх однією командою в боті.',
      },
      {
        icon: '📝',
        title: 'Довгі пости повністю',
        text: 'Довгий пост із X публікується цілим: підпис під медіа, а повний текст — окремим повідомленням, якщо він не вміщується.',
      },
      {
        icon: '🔗',
        title: 'Посилання на джерело',
        text: 'Під кожним постом — посилання на оригінал у X. Репости й відповіді пропускаються, тож у канал іде лише власний контент автора.',
      },
      {
        icon: '🛡',
        title: 'Жодних дублів',
        text: 'Бот пам’ятає кожен опублікований пост. Подвійне натискання кнопки чи збіг двох запусків не опублікують його вдруге.',
      },
    ],
  },
  steps: {
    title: 'Як це працює',
    lead: 'Налаштування займає кілька хвилин і не потребує коду.',
    items: [
      { title: 'Напишіть нам', text: 'Ми підключимо ваш канал і вас як модератора.' },
      { title: 'Додайте бота в канал', text: 'Зробіть бота адміністратором свого Telegram-каналу з правом публікації.' },
      { title: 'Вкажіть акаунти X', text: 'Напишіть боту /addsource @username — і він почне стежити за акаунтом.' },
      {
        title: 'Погоджуйте й публікуйте',
        text: 'Нові пости приходять вам у бот рівно такими, як виглядатимуть у каналі. Approve — і пост опубліковано.',
      },
    ],
  },
  audiences: {
    title: 'Для кого',
    items: [
      {
        title: 'Новинні й тематичні канали',
        text: 'Оперативно переносьте пости з ключових акаунтів своєї ніші й залишайте собі лише редакторську роботу.',
      },
      {
        title: 'Адміни, які цінують час',
        text: 'Замість копіювання й перезавантаження медіа вручну — одне натискання на кожен пост.',
      },
      {
        title: 'Мережі каналів',
        text: 'Один сервіс на кілька каналів: у кожного свої джерела й свій модератор.',
      },
    ],
  },
  faq: {
    title: 'Часті запитання',
    items: [
      {
        question: 'Чи потрібен мені власний доступ до X API?',
        answer:
          'Ні. Доступ до X — на нашому боці. Вам потрібні лише Telegram-канал і бот, доданий у нього адміністратором.',
      },
      {
        question: 'Як швидко новий пост потрапляє в канал?',
        answer:
          'Бот перевіряє акаунти щогодини й одразу надсилає нові пости вам на погодження. У канал пост іде, щойно ви натиснете Approve, — або в запланований вами час.',
      },
      {
        question: 'Які пости переносяться?',
        answer:
          'Пости з фото й відео, зокрема альбоми й довгі тексти. Пости без медіа можна ввімкнути окремо для кожного акаунта. Репости й відповіді пропускаються.',
      },
      {
        question: 'Чи можна стежити за закритими акаунтами?',
        answer: 'Ні. Сервіс працює лише з публічними акаунтами X.',
      },
      {
        question: 'Чи з’явиться запланований пост у розділі «Відкладені» каналу?',
        answer:
          'Ні — Telegram не дозволяє ботам користуватися цим розділом. Розклад веде сам бот і публікує пост протягом хвилини від обраного часу. Список запланованого — за командою /scheduled.',
      },
      {
        question: 'Що, як я відхиляю пост?',
        answer:
          'Він не потрапить у канал і більше не прийде. Бот запропонує обрати причину зі списку або написати свою — так з часом стане видно, які пости вашому каналу не підходять.',
      },
      {
        question: 'Скільки це коштує?',
        answer:
          'Вартість залежить від кількості каналів і акаунтів, за якими треба стежити. Напишіть нам у Telegram — підберемо варіант.',
      },
    ],
  },
  cta: {
    title: 'Підключіть свій канал',
    text: 'Напишіть нам у Telegram — допоможемо налаштувати бота й підібрати акаунти для стеження.',
    button: 'Написати в Telegram',
  },
  footer: {
    disclaimer:
      'X — торгова марка X Corp., Telegram — Telegram FZ-LLC. Сервіс не пов’язаний із ними.',
    contact: 'Зв’язатися в Telegram',
  },
};

export const CONTENT: Record<Locale, LandingContent> = { en, uk };
