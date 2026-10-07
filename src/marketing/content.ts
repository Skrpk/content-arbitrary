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
  meta: { title: string; description: string; ogHeadline: string; ogSubline: string; ogBadge: string };
  nav: { features: string; howItWorks: string; faq: string; home: string; main: string };
  skipLink: string;
  connect: string;
  languageSwitch: { label: string; names: Record<Locale, string> };
  hero: { eyebrow: string; title: string; lead: string; primary: string; secondary: string };
  mockup: {
    label: string;
    /** The source's post as it was published on X, in English. */
    originalLabel: string;
    original: string;
    rewritten: string;
    /** The same post as the reviewer receives it, in the channel's language. */
    text: string;
    textLang: string;
    caption: string;
  };
  features: { title: string; lead: string; items: (Item & { icon: string })[] };
  steps: { title: string; lead: string; items: Item[] };
  audiences: { title: string; items: Item[] };
  faq: { title: string; items: { question: string; answer: string }[] };
  cta: { title: string; text: string; button: string };
  footer: { disclaimer: string; contact: string };
}

/** The same source post on every page: it is English on X whatever the site's language. */
const ORIGINAL_POST =
  'First images from our new mission are in: the probe has sent back the sharpest views of the surface ever taken. 🛰️';

const en: LandingContent = {
  meta: {
    title: 'An AI editor for your Telegram channel: posts from X in your language and voice',
    description:
      'A Telegram bot that follows the X accounts you choose, rewrites their new posts in your ' +
      'channel’s language and style, and sends them to you for review — photos, videos, albums ' +
      'and long posts. Approve, edit, reject or schedule them right in Telegram.',
    ogHeadline: 'An AI editor for your Telegram channel',
    ogSubline: 'Posts from X, rewritten in your language and voice — you approve',
    ogBadge: 'For Telegram channels',
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
    eyebrow: 'An AI editorial assistant for Telegram channels',
    title: 'Posts from the sources you follow, written for your channel and waiting for your approval',
    lead:
      'The bot follows the X accounts you pick, rewrites every new post in your channel’s ' +
      'language and style, and sends it to you exactly as it will appear. Approve, edit, reject ' +
      'or schedule: the routine is the bot’s, the decisions stay yours. All inside Telegram.',
    primary: 'Connect your channel',
    secondary: 'How it works',
  },
  mockup: {
    label: 'How a post from X arrives for review, rewritten for the channel',
    originalLabel: 'On X · @source_account',
    original: ORIGINAL_POST,
    rewritten: 'Rewritten for a Spanish-language channel',
    text: '🛰 Primeras imágenes de la nueva misión: la sonda ha enviado las vistas más nítidas de la superficie jamás tomadas.',
    textLang: 'es',
    caption: 'The post in your chat with the bot, in your channel’s language — before it reaches the channel.',
  },
  features: {
    title: 'From a source’s post to your channel’s post',
    lead: 'No copying, no translating by hand, no re-uploading videos: what is left for you is the editorial decision.',
    items: [
      {
        icon: '🌐',
        title: 'In your channel’s language',
        text: 'Set your channel’s language once, and every post arrives already in it: rewritten the way a channel writes, not translated word for word. Facts, numbers and names stay as in the original.',
      },
      {
        icon: '🎙',
        title: 'In your channel’s voice',
        text: 'We import your channel’s past posts, and the bot picks up how it writes — tone, length, paragraphs, emoji — and writes new posts to match.',
      },
      {
        icon: '✅',
        title: 'Nothing goes out without you',
        text: 'Every post comes to you in the bot first. Approve it and it goes to the channel; reject it with a reason. Nothing is published without your say.',
      },
      {
        icon: '✏️',
        title: 'Edit before publishing',
        text: 'Polish any post right in Telegram, in a built-in editor with a character counter. The media stays as it is.',
      },
      {
        icon: '🕒',
        title: 'Scheduled publishing',
        text: 'Pick a date and time and the post goes out that minute. Move the time, publish it early, or send it back to review.',
      },
      {
        icon: '📚',
        title: 'Several sources per channel',
        text: 'Follow several X accounts for one channel. Add, pause and remove them with a single command in the bot.',
      },
      {
        icon: '🖼',
        title: 'Photos, videos, albums, long posts',
        text: 'Albums arrive as albums, videos in the best quality Telegram accepts, and a long post whole — with the rest of the text as a follow-up when it does not fit.',
      },
      {
        icon: '🛡',
        title: 'No duplicates, always the source',
        text: 'The bot remembers every post it has published, so nothing goes out twice, and every post links back to the original on X.',
      },
    ],
  },
  steps: {
    title: 'How it works',
    lead: 'Setup takes a few minutes and needs no code.',
    items: [
      { title: 'Get in touch', text: 'We connect your channel, set its language and set you up as its moderator.' },
      { title: 'Add the bot to your channel', text: 'Make the bot an admin of your Telegram channel with the right to post.' },
      {
        title: 'Pick sources, share your channel',
        text: 'Send the bot /addsource @username for each X account. Send us your channel’s export from Telegram Desktop, and posts will be written in its voice.',
      },
      {
        title: 'Review and publish',
        text: 'New posts arrive in the bot in your channel’s language, exactly as they will look. Tap Approve and it is published.',
      },
    ],
  },
  audiences: {
    title: 'Who it is for',
    items: [
      {
        title: 'Channels whose sources speak another language',
        text: 'Run a channel in your language on the best accounts in English: posts arrive already rewritten, in your style.',
      },
      {
        title: 'News and niche channels',
        text: 'Bring in posts from the key accounts of your niche fast, and keep only the editorial work for yourself.',
      },
      {
        title: 'Channel networks',
        text: 'One service for several channels, each with its own sources, language and moderator.',
      },
    ],
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      {
        question: 'Is it a word-for-word translation?',
        answer:
          'No. Each post is rewritten as your channel would write it — in its language, tone and format — sticking to the facts, numbers and names of the original and adding none of its own. You see every post before it goes out and can edit it, and the link to the original is always there.',
      },
      {
        question: 'How does the bot learn my channel’s style?',
        answer:
          'From your channel’s own posts: you export its history from Telegram Desktop, we import it once, and the bot builds a profile of how your channel writes. Without it, posts are still rewritten in your channel’s language, in a neutral style.',
      },
      {
        question: 'What if a post is already in my channel’s language?',
        answer:
          'It is left as it is. And if a rewrite ever fails, the post still arrives — in its original language — rather than being lost.',
      },
      {
        question: 'Do I need my own X API access?',
        answer:
          'No. X access is on our side. All you need is a Telegram channel and the bot added to it as an admin.',
      },
      {
        question: 'How fast does a new post reach my channel?',
        answer:
          'The bot checks the accounts every 15 minutes and sends new posts to you for review right away. A post goes to the channel as soon as you tap Approve — or at the time you scheduled.',
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
    text: 'Message us on Telegram — we will set up the bot, your channel’s language and the accounts to follow.',
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
    title: 'AI-редактор для Telegram-каналу: пости з X вашою мовою і вашим стилем',
    description:
      'Telegram-бот, який стежить за обраними акаунтами в X, переписує їхні нові пости мовою ' +
      'й у стилі вашого каналу та надсилає вам на погодження — фото, відео, альбоми й довгі ' +
      'тексти. Погоджуйте, редагуйте, відхиляйте й плануйте публікації прямо в Telegram.',
    ogHeadline: 'AI-редактор для вашого Telegram-каналу',
    ogSubline: 'Пости з X, переписані вашою мовою і стилем — ви погоджуєте',
    ogBadge: 'Для Telegram-каналів',
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
    eyebrow: 'AI-помічник редактора Telegram-каналу',
    title: 'Пости з ваших джерел, написані під ваш канал, — чекають лише вашого рішення',
    lead:
      'Бот стежить за обраними акаунтами в X, переписує кожен новий пост мовою й у стилі вашого ' +
      'каналу та надсилає його вам саме таким, яким він вийде. Погодьте, відредагуйте, відхиліть ' +
      'чи заплануйте: рутина — на боті, рішення — за вами. Усе прямо в Telegram.',
    primary: 'Підключити канал',
    secondary: 'Як це працює',
  },
  mockup: {
    label: 'Так пост з X приходить на погодження — вже переписаний для каналу',
    originalLabel: 'У X · @source_account',
    original: ORIGINAL_POST,
    rewritten: 'Переписано для україномовного каналу',
    text: '🛰 Перші кадри з нової місії: зонд передав найчіткіші знімки поверхні за всю історію спостережень.',
    textLang: 'uk',
    caption: 'Пост у вашому чаті з ботом — уже мовою каналу, до публікації.',
  },
  features: {
    title: 'Від поста джерела до поста вашого каналу',
    lead: 'Без копіювання, ручного перекладу й перезавантаження відео: вам лишається тільки редакторське рішення.',
    items: [
      {
        icon: '🌐',
        title: 'Мовою вашого каналу',
        text: 'Вкажіть мову каналу один раз — і кожен пост приходить уже нею: переписаний так, як пише канал, а не перекладений дослівно. Факти, цифри й імена — як в оригіналі.',
      },
      {
        icon: '🎙',
        title: 'Голосом вашого каналу',
        text: 'Ми імпортуємо минулі пости каналу, і бот переймає, як він пише, — тон, довжину, абзаци, емодзі — та пише нові пости так само.',
      },
      {
        icon: '✅',
        title: 'Нічого без вашого рішення',
        text: 'Кожен пост спершу приходить вам у бот. Погодили — пішов у канал, відхилили — з причиною. Нічого не публікується без вас.',
      },
      {
        icon: '✏️',
        title: 'Редагування перед публікацією',
        text: 'Доведіть будь-який пост до ладу прямо в Telegram — у вбудованому редакторі з лічильником символів. Медіа лишається без змін.',
      },
      {
        icon: '🕒',
        title: 'Відкладена публікація',
        text: 'Оберіть дату й час — пост вийде в канал у цю хвилину. Час можна змінити, а пост — опублікувати раніше чи повернути на розгляд.',
      },
      {
        icon: '📚',
        title: 'Кілька джерел на канал',
        text: 'Стежте за кількома акаунтами X для одного каналу. Додавайте, ставте на паузу й прибирайте їх однією командою в боті.',
      },
      {
        icon: '🖼',
        title: 'Фото, відео, альбоми, довгі пости',
        text: 'Альбоми приходять альбомами, відео — у найкращій якості, яку приймає Telegram, а довгий пост — цілим: решта тексту окремим повідомленням, якщо не вміщується.',
      },
      {
        icon: '🛡',
        title: 'Без дублів, завжди з джерелом',
        text: 'Бот пам’ятає кожен опублікований пост, тож нічого не вийде двічі, а під кожним постом — посилання на оригінал у X.',
      },
    ],
  },
  steps: {
    title: 'Як це працює',
    lead: 'Налаштування займає кілька хвилин і не потребує коду.',
    items: [
      { title: 'Напишіть нам', text: 'Ми підключимо ваш канал, задамо його мову й зробимо вас модератором.' },
      { title: 'Додайте бота в канал', text: 'Зробіть бота адміністратором свого Telegram-каналу з правом публікації.' },
      {
        title: 'Оберіть джерела й покажіть канал',
        text: 'Напишіть боту /addsource @username для кожного акаунта X. Надішліть нам експорт каналу з Telegram Desktop — і пости писатимуться його голосом.',
      },
      {
        title: 'Погоджуйте й публікуйте',
        text: 'Нові пости приходять у бот мовою вашого каналу, рівно такими, як виглядатимуть. Approve — і пост опубліковано.',
      },
    ],
  },
  audiences: {
    title: 'Для кого',
    items: [
      {
        title: 'Канали, чиї джерела пишуть іншою мовою',
        text: 'Ведіть український канал на найкращих англомовних акаунтах: пости приходять уже переписаними, у вашому стилі.',
      },
      {
        title: 'Новинні й тематичні канали',
        text: 'Оперативно переносьте пости з ключових акаунтів своєї ніші й залишайте собі лише редакторську роботу.',
      },
      {
        title: 'Мережі каналів',
        text: 'Один сервіс на кілька каналів: у кожного свої джерела, своя мова й свій модератор.',
      },
    ],
  },
  faq: {
    title: 'Часті запитання',
    items: [
      {
        question: 'Це дослівний переклад?',
        answer:
          'Ні. Кожен пост переписується так, як написав би його ваш канал, — його мовою, тоном і форматом, — тримаючись фактів, цифр та імен оригіналу й нічого не додаючи від себе. Ви бачите кожен пост до публікації й можете його відредагувати, а посилання на оригінал завжди поруч.',
      },
      {
        question: 'Як бот дізнається стиль мого каналу?',
        answer:
          'З постів самого каналу: ви експортуєте його історію з Telegram Desktop, ми один раз її імпортуємо, і бот складає профіль того, як пише канал. Без цього пости все одно переписуються мовою каналу, просто в нейтральному стилі.',
      },
      {
        question: 'А якщо пост уже мовою мого каналу?',
        answer:
          'Він лишається як є. А якщо переписати пост колись не вдасться, він однаково прийде — мовою оригіналу, — а не загубиться.',
      },
      {
        question: 'Чи потрібен мені власний доступ до X API?',
        answer:
          'Ні. Доступ до X — на нашому боці. Вам потрібні лише Telegram-канал і бот, доданий у нього адміністратором.',
      },
      {
        question: 'Як швидко новий пост потрапляє в канал?',
        answer:
          'Бот перевіряє акаунти кожні 15 хвилин і одразу надсилає нові пости вам на погодження. У канал пост іде, щойно ви натиснете Approve, — або в запланований вами час.',
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
    text: 'Напишіть нам у Telegram — налаштуємо бота, мову каналу й акаунти для стеження.',
    button: 'Написати в Telegram',
  },
  footer: {
    disclaimer:
      'X — торгова марка X Corp., Telegram — Telegram FZ-LLC. Сервіс не пов’язаний із ними.',
    contact: 'Зв’язатися в Telegram',
  },
};

export const CONTENT: Record<Locale, LandingContent> = { en, uk };
