import type { Locale } from './i18n';

/**
 * Every word on the public site, per language.
 *
 * Everything claimed here is something the product does today — the labels
 * in the mock-up are the review queue's real ones, and stay in English in
 * both languages because that is how the queue shows them. Keep it that way: a
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
  hero: {
    eyebrow: string;
    /** The headline in three runs: the middle one is under the marker. */
    title: { before: string; marked: string; after: string };
    lead: string;
    primary: string;
    secondary: string;
    note: string;
  };
  mockup: {
    label: string;
    /** Above the morning's feed, and above its column of scores. */
    feedLabel: string;
    scoreLabel: string;
    merged: string;
    /** Radar's one-line why, in the site's language. */
    reason: string;
    /** The lead post as the reviewer gets it, in the channel's language. */
    text: string;
    textLang: string;
    caption: string;
  };
  /** What it reads and where it publishes, in one line under the hero. */
  strip: { reads: string; sources: string[]; publishes: string; targets: string[] };
  features: {
    eyebrow: string;
    title: string;
    /** The first four get a picture each; the rest are a quiet row under them. */
    items: Item[];
    /** What three sources become, in the picture of one story. */
    foldResult: string;
    /** What the voice is made of, and where it is learned from. */
    voiceTraits: string[];
    voiceSource: string;
  };
  /** A day with the service and a day without. */
  compare: Record<'before' | 'after', { label: string; title: string; items: string[] }>;
  steps: { title: string; lead: string; items: Item[] };
  audiences: { title: string; items: Item[] };
  useCases: { title: string; lead: string; more: string };
  faq: { title: string; items: { question: string; answer: string }[] };
  cta: { title: string; text: string; button: string };
  footer: { disclaimer: string; contact: string; about: string; privacy: string; terms: string };
}

/**
 * The same three source posts on every page: they are English at the source
 * whatever the site's language. The product's own labels in the mock-up —
 * Approve, the score's verdict, "Same story" — are English too, as the review
 * queue shows them.
 */
export const MOCKUP_SOURCES = [
  { platform: 'X', name: '@NASA', text: 'Webb has traced the most distant fast radio burst ever found to its home galaxy. 🔭' },
  { platform: 'RSS', name: 'Space.com', text: 'James Webb pins down the farthest FRB yet — 8 billion light-years away' },
  { platform: 'Telegram', name: '@spacenews', text: 'Record radio burst traced by Webb to a faint dwarf galaxy' },
] as const;

/**
 * A morning's feed as the hero shows it: the few posts worth running under the
 * marker, the two repeats of the lead story folded into it, the rest passed
 * over. Illustrative, like the three above, and English at the source.
 */
export const MOCKUP_FEED: { platform: string; text: string; score?: number; kind: 'pick' | 'same' | 'skip' }[] = [
  { platform: 'X', text: 'Thread: 10 space photos you missed this week', score: 14, kind: 'skip' },
  { platform: 'X', text: '@NASA — Webb traces the most distant fast radio burst to its home galaxy', score: 82, kind: 'pick' },
  { platform: 'RSS', text: 'Space.com — James Webb pins down the farthest FRB yet', kind: 'same' },
  { platform: 'TG', text: '@spacenews — Record radio burst traced by Webb', kind: 'same' },
  { platform: 'YT', text: 'Livestream starting soon: weekly Q&A', score: 9, kind: 'skip' },
  { platform: 'RSS', text: 'ESA — First light from the new Earth-observation satellite', score: 74, kind: 'pick' },
  { platform: 'X', text: 'Reposting last week’s thread in case you missed it', score: 6, kind: 'skip' },
  { platform: 'WEB', text: 'Opinion: what the launch delay really means', score: 21, kind: 'skip' },
  { platform: 'TG', text: '@launchwatch — Crewed lunar flyby gets its launch window', score: 68, kind: 'pick' },
];

const en: LandingContent = {
  meta: {
    title: 'AI editorial desk for Telegram and Threads',
    description:
      'Zmistik follows X, Threads, RSS, YouTube, Telegram and websites, ranks new posts and rewrites ' +
      'them in your voice for Telegram, Threads or both. You decide.',
    ogHeadline: 'An AI editorial desk for your channels',
    ogSubline: 'Your sources, ranked and rewritten in your voice — you decide',
    ogBadge: 'Telegram · Threads',
  },
  nav: {
    features: 'Features',
    howItWorks: 'How it works',
    faq: 'FAQ',
    home: 'home',
    main: 'Main navigation',
  },
  skipLink: 'Skip to content',
  connect: 'Message us',
  languageSwitch: { label: 'Language', names: { en: 'EN', uk: 'UK' } },
  hero: {
    eyebrow: 'For people who run news channels and social accounts',
    title: { before: 'Twenty feeds in. ', marked: 'Three posts worth running', after: ' out.' },
    lead:
      'Zmistik reads every source you follow, folds repeats of one story into a single card and drafts it in your ' +
      'language and voice. You only decide: publish to Telegram, Threads or both, schedule, or reject.',
    primary: 'Message us on Telegram',
    secondary: 'See how it works',
    note: 'Setup takes a few minutes and needs no code. The score sorts the queue; you decide.',
  },
  mockup: {
    label: 'Three sources report one event, and it reaches the review queue as one ranked card',
    feedLabel: 'Your sources, this morning',
    scoreLabel: 'Score',
    merged: 'One card in your queue, ranked and rewritten for a Spanish-language channel',
    reason: 'Record-breaking Webb news, like the posts you publish.',
    text: '🔭 Webb ha rastreado la ráfaga rápida de radio más lejana jamás detectada hasta su galaxia de origen.',
    textLang: 'es',
    caption: 'Best-scored first. Send it to Telegram, Threads or both, and the other two are marked as already covered.',
  },
  strip: {
    reads: 'Reads',
    sources: ['X', 'Threads', 'RSS & Atom', 'Telegram', 'YouTube', 'Any website'],
    publishes: 'Publishes to',
    targets: ['Telegram', 'Threads'],
  },
  features: {
    eyebrow: 'The desk',
    title: 'The reading, sorting and rewriting are done. The call is still yours.',
    foldResult: '1 card',
    voiceTraits: ['tone', 'length', 'paragraphs', 'emoji'],
    voiceSource: 'learned from your past posts',
    items: [
      {
        title: 'Best posts first',
        text: 'Every post gets a score: how likely you are to publish it. It learns from what you approve, the reasons you give when you reject, and what you have published before. You can also describe in Settings what you publish and what you turn down. It sorts the queue; it never decides for you.',
      },
      {
        title: 'One story, one card',
        text: 'When several sources report the same event, it arrives as one card: pick the best version, and the rest are set aside as already covered. A source posting the same thing again is marked 🔁.',
      },
      {
        title: 'In your language',
        text: 'Set your language once, and every post arrives already in it: rewritten the way you write, not translated word for word. Facts, numbers and names stay as in the original.',
      },
      {
        title: 'In your voice',
        text: 'We import your Telegram channel’s past posts, and Zmistik picks up how it writes — tone, length, paragraphs, emoji — and writes new posts to match.',
      },
      {
        title: 'An AI assistant in the editor',
        text: 'Ask “make it shorter” or “add context”, and the post changes in place — one click undoes it. Ask it to fact-check, and it searches the web and answers with sources.',
      },
      {
        title: 'Sources of every kind',
        text: 'Follow X and Threads accounts, RSS and Atom feeds, public Telegram and YouTube channels, and websites through their sitemaps — as many as you need for each channel, added in a click or with a command in the bot.',
      },
      {
        title: 'Review on your schedule',
        text: 'Posts wait in one queue, in Telegram or in the browser, and you get a note when new ones come in — every hour, once a day at the hour you choose, or post by post. Schedule any post for later.',
      },
      {
        title: 'Telegram, Threads or both',
        text: 'Connect a Threads account beside your Telegram channel, and choose where each post goes when you approve or schedule it. Photos, videos and albums go too — on Threads an album is a carousel — and nothing is published twice.',
      },
    ],
  },
  compare: {
    before: {
      label: 'Without Zmistik',
      title: 'Hours searching',
      items: [
        'Read everything every source publishes',
        'Notice that five posts are the same news',
        'Rewrite it before someone else posts it first',
        'Re-upload the photos and videos by hand',
      ],
    },
    after: {
      label: 'With Zmistik',
      title: 'Minutes deciding',
      items: [
        'Open one queue, best-scored first',
        'One card per story, already in your language',
        'Publish, schedule, edit or reject',
        'Photos and videos go out with the post',
      ],
    },
  },
  steps: {
    title: 'How it works',
    lead: 'Setup takes a few minutes and needs no code.',
    items: [
      { title: 'Get in touch', text: 'We set up your channel, its language, and make you its editor.' },
      {
        title: 'Connect where you publish',
        text: 'Make the bot an admin of your Telegram channel with the right to post. To publish on Threads too, connect your account on the website, in Meta’s own window.',
      },
      {
        title: 'Pick sources, share your channel',
        text: 'Add X and Threads accounts, RSS feeds, Telegram and YouTube channels, and websites on the website or in the bot. Send us your channel’s export from Telegram Desktop, so ranking and rewriting learn from it.',
      },
      {
        title: 'Review and publish',
        text: 'Open the queue: the posts most likely to fit come first, already in your language. Approve, and it is published to Telegram, Threads or both.',
      },
    ],
  },
  audiences: {
    title: 'Who it is for',
    items: [
      {
        title: 'Editors whose sources speak another language',
        text: 'Run a channel in your language on the best sources in English: posts arrive already rewritten, in your style.',
      },
      {
        title: 'News and niche media',
        text: 'Follow every key source of your niche without drowning in it: the same news from ten accounts is one card, and the best of the day is at the top.',
      },
      {
        title: 'Several channels, several platforms',
        text: 'One service for several channels, each with its own sources, language, editor and rules. A Telegram channel and its Threads account share one queue: decide once, publish to both.',
      },
    ],
  },
  useCases: {
    title: 'What you can do with it',
    lead: 'Each of these has its own page: how it works, and what it does not do.',
    more: 'More on what Zmistik does',
  },
  faq: {
    title: 'Frequently asked questions',
    items: [
      {
        question: 'Does Zmistik decide what gets published?',
        answer:
          'No. The score only orders the queue — best first — with a one-line reason. Every post is still there for you to see, and nothing reaches the channel unless you approve it, or switch review off for that channel.',
      },
      {
        question: 'How does it know what my channel would publish?',
        answer:
          'From you: the posts you approve, the ones you reject and the reasons you pick, and your channel’s past posts if you share its history. You can also write down in Settings what your channel publishes and what it turns down. The more you review, the better it sorts. We measure it against your own decisions.',
      },
      {
        question: 'What happens when several sources post the same news?',
        answer:
          'They are grouped into one story and shown as one card, with the best-scored version on top and the others under it. Publish the one you like, and the rest are rejected as already covered. If you already published the story, the card says so.',
      },
      {
        question: 'What can the AI assistant do?',
        answer:
          'In the website’s post editor it rewrites the post as you ask — shorter, another tone, a better headline, a translated caption — and shows the change at once; one click undoes it. For a fact check it searches the web and tells you what holds and what does not, with links.',
      },
      {
        question: 'Is it a word-for-word translation?',
        answer:
          'No. Each post is rewritten as your channel would write it — in its language, tone and format — sticking to the facts, numbers and names of the original and adding none of its own. You see every post before it goes out, and the link to the original is always there.',
      },
      {
        question: 'Which sources can I follow?',
        answer:
          'Public X and Threads accounts, RSS and Atom feeds of any site, public Telegram and YouTube channels, and websites through their sitemaps: a new article on the site arrives as a post that links to it. From X and Threads, posts with photos and videos come in, and posts without media can be switched on per account; reposts are skipped, and so are replies on X.',
      },
      {
        question: 'Where can posts be published?',
        answer:
          'To a Telegram channel and to a Threads account. Connect Threads on the website, in Meta’s own window — we never see your password — and when you approve or schedule a post, pick Telegram, Threads or both. Threads takes 500 characters, so a longer post is shortened there; one without pictures keeps its whole text as an attachment.',
      },
      {
        question: 'Can posts go out without review?',
        answer:
          'Yes, per channel. A channel that reposts everything its sources publish can skip review, and posts go straight to the Telegram channel — rewritten, in the channel’s language.',
      },
      {
        question: 'Do I need my own X API access?',
        answer:
          'No. Reading X and Threads is on our side. All you need is a Telegram channel with the bot added as an admin, and a Threads account if you publish there too.',
      },
      {
        question: 'How fast does a new post get published?',
        answer:
          'Sources are checked every 15 minutes, and new posts go to your queue straight away. A post goes to Telegram as soon as you approve it — or at the time you scheduled — and to Threads shortly after, once Threads has processed its pictures or video.',
      },
      {
        question: 'Will a scheduled post show up in the channel’s “Scheduled messages”?',
        answer:
          'No — Telegram does not let bots use that list. Zmistik keeps the schedule itself and publishes the post within a minute of the chosen time.',
      },
      {
        question: 'How much does it cost?',
        answer:
          'It depends on how many channels and sources you need. Message us on Telegram and we will find the right option.',
      },
    ],
  },
  cta: {
    title: 'Tomorrow’s queue could already be sorted.',
    text: 'Message us on Telegram — we will set up your channel, its language and the sources to follow.',
    button: 'Message us on Telegram',
  },
  footer: {
    disclaimer:
      'X, Telegram and Threads are trademarks of their owners. This service is not affiliated with X Corp., Telegram or Meta.',
    contact: 'Contact us on Telegram',
    about: 'About',
    privacy: 'Privacy',
    terms: 'Terms',
  },
};

const uk: LandingContent = {
  meta: {
    title: 'AI-редакція для Telegram і Threads',
    description:
      'Zmistik стежить за X, Threads, RSS, YouTube, Telegram і сайтами, оцінює нові пости й переписує ' +
      'їх вашим голосом для Telegram, Threads чи обох. Рішення за вами.',
    ogHeadline: 'AI-редакція для ваших каналів',
    ogSubline: 'Ваші джерела — відсортовані й переписані вашим голосом. Рішення за вами',
    ogBadge: 'Telegram · Threads',
  },
  nav: {
    features: 'Можливості',
    howItWorks: 'Як це працює',
    faq: 'Питання',
    home: 'на головну',
    main: 'Основна навігація',
  },
  skipLink: 'Перейти до змісту',
  connect: 'Написати нам',
  languageSwitch: { label: 'Мова', names: { en: 'EN', uk: 'UK' } },
  hero: {
    eyebrow: 'Для тих, хто веде новинні канали й акаунти в соцмережах',
    title: { before: 'Двадцять стрічок на вході. ', marked: 'Три пости, варті публікації,', after: ' — на виході.' },
    lead:
      'Zmistik читає всі ваші джерела, збирає повтори однієї історії в одну картку й готує текст вашою мовою та ' +
      'голосом. Вам лишається рішення: опублікувати в Telegram, Threads чи в обидва, запланувати або відхилити.',
    primary: 'Написати в Telegram',
    secondary: 'Як це працює',
    note: 'Налаштування займає кілька хвилин і не потребує коду. Оцінка сортує чергу — рішення за вами.',
  },
  mockup: {
    label: 'Три джерела пишуть про одну подію — і вона приходить у чергу однією оціненою карткою',
    feedLabel: 'Ваші джерела, цього ранку',
    scoreLabel: 'Оцінка',
    merged: 'Одна картка у вашій черзі — оцінена й переписана для україномовного каналу',
    reason: 'Рекордна новина від Webb — як ті, що ви публікуєте.',
    text: '🔭 Webb відстежив найвіддаленіший із відомих швидких радіосплесків до його рідної галактики.',
    textLang: 'uk',
    caption: 'Найкращі — першими. Надішліть у Telegram, Threads чи в обидва — а два інші позначаться як уже висвітлені.',
  },
  strip: {
    reads: 'Читає',
    sources: ['X', 'Threads', 'RSS і Atom', 'Telegram', 'YouTube', 'Будь-який сайт'],
    publishes: 'Публікує в',
    targets: ['Telegram', 'Threads'],
  },
  features: {
    eyebrow: 'Редакція',
    title: 'Читання, сортування й переписування вже зроблено. Рішення — за вами.',
    foldResult: '1 картка',
    voiceTraits: ['тон', 'довжина', 'абзаци', 'емодзі'],
    voiceSource: 'з ваших минулих постів',
    items: [
      {
        title: 'Найкращі пости — першими',
        text: 'Кожен пост отримує оцінку: наскільки ймовірно ви його опублікуєте. Вона вчиться на тому, що ви погоджуєте, на причинах відмов і на тому, що ви публікували раніше. У налаштуваннях можна також описати, що ви публікуєте і що відсіваєте. Оцінка лише сортує чергу — рішень за вас не ухвалює.',
      },
      {
        title: 'Одна історія — одна картка',
        text: 'Коли кілька джерел пишуть про ту саму подію, вона приходить однією карткою: оберіть найкращу версію, а решта відкладеться як уже висвітлена. Якщо джерело повторює той самий пост, він позначений 🔁.',
      },
      {
        title: 'Вашою мовою',
        text: 'Вкажіть мову один раз — і кожен пост приходить уже нею: переписаний так, як пишете ви, а не перекладений дослівно. Факти, цифри й імена — як в оригіналі.',
      },
      {
        title: 'Вашим голосом',
        text: 'Ми імпортуємо минулі пости вашого Telegram-каналу, і Zmistik переймає, як він пише, — тон, довжину, абзаци, емодзі — та пише нові пости так само.',
      },
      {
        title: 'AI-асистент у редакторі',
        text: 'Попросіть «зроби коротше» чи «додай контекст» — і пост зміниться на місці, а скасувати можна одним кліком. Попросіть перевірити факти — асистент пошукає в інтернеті й відповість із джерелами.',
      },
      {
        title: 'Джерела будь-якого типу',
        text: 'Стежте за акаунтами X і Threads, RSS- і Atom-стрічками, публічними Telegram- і YouTube-каналами та сайтами через їхні sitemap — скільки треба для кожного каналу. Додаються одним кліком або командою в боті.',
      },
      {
        title: 'Розгляд у зручному ритмі',
        text: 'Пости чекають в одній черзі — у Telegram або в браузері, — а про нові ви дізнаєтеся тоді, коли зручно: щогодини, раз на день у вибрану годину чи кожен окремо. Будь-який пост можна запланувати.',
      },
      {
        title: 'Telegram, Threads або обидва',
        text: 'Підключіть акаунт Threads поруч із Telegram-каналом і обирайте, куди йде кожен пост, коли погоджуєте чи плануєте його. Фото, відео й альбоми теж ідуть — у Threads альбом стає каруселлю, — і нічого не вийде двічі.',
      },
    ],
  },
  compare: {
    before: {
      label: 'Без Zmistik',
      title: 'Години на пошук',
      items: [
        'Читати все, що публікує кожне джерело',
        'Помічати, що п’ять постів — та сама новина',
        'Переписувати, поки хтось не опублікував першим',
        'Перезавантажувати фото й відео вручну',
      ],
    },
    after: {
      label: 'Із Zmistik',
      title: 'Хвилини на рішення',
      items: [
        'Одна черга: найкращі — першими',
        'Одна картка на історію, уже вашою мовою',
        'Опублікувати, запланувати, відредагувати чи відхилити',
        'Фото й відео виходять разом із постом',
      ],
    },
  },
  steps: {
    title: 'Як це працює',
    lead: 'Налаштування займає кілька хвилин і не потребує коду.',
    items: [
      { title: 'Напишіть нам', text: 'Ми налаштуємо ваш канал, задамо його мову й зробимо вас його редактором.' },
      {
        title: 'Підключіть, де публікуєте',
        text: 'Зробіть бота адміністратором свого Telegram-каналу з правом публікації. Щоб публікувати ще й у Threads, підключіть акаунт на сайті — у власному вікні Meta.',
      },
      {
        title: 'Оберіть джерела й покажіть канал',
        text: 'Додайте акаунти X і Threads, RSS-стрічки, Telegram- і YouTube-канали та сайти на сайті або в боті. Надішліть нам експорт каналу з Telegram Desktop — оцінка й переписування вчитимуться на ньому.',
      },
      {
        title: 'Погоджуйте й публікуйте',
        text: 'Відкрийте чергу: першими — пости, які найімовірніше підійдуть, уже вашою мовою. Погодили — і пост опубліковано в Telegram, Threads чи в обох.',
      },
    ],
  },
  audiences: {
    title: 'Для кого',
    items: [
      {
        title: 'Редактори, чиї джерела пишуть іншою мовою',
        text: 'Ведіть український канал на найкращих англомовних джерелах: пости приходять уже переписаними, у вашому стилі.',
      },
      {
        title: 'Новинні й тематичні медіа',
        text: 'Стежте за всіма ключовими джерелами ніші й не тоніть у них: та сама новина з десяти акаунтів — одна картка, а найкраще за день — угорі.',
      },
      {
        title: 'Кілька каналів, кілька платформ',
        text: 'Один сервіс на кілька каналів: у кожного свої джерела, мова, редактор і правила. Telegram-канал і його акаунт у Threads мають одну чергу: вирішуєте раз — публікуєте в обидва.',
      },
    ],
  },
  useCases: {
    title: 'Що можна робити',
    lead: 'Про кожне є окрема сторінка: як це працює і чого сервіс не робить.',
    more: 'Що ще вміє Zmistik',
  },
  faq: {
    title: 'Часті запитання',
    items: [
      {
        question: 'Zmistik сам вирішує, що публікувати?',
        answer:
          'Ні. Оцінка лише впорядковує чергу — найкращі першими — і пояснює себе одним реченням. Усі пости лишаються у вас перед очима, і жоден не потрапить у канал, поки ви не погодите — хіба що ви вимкнете розгляд для цього каналу.',
      },
      {
        question: 'Звідки він знає, що опублікував би мій канал?',
        answer:
          'Від вас: з постів, які ви погоджуєте, з тих, що відхиляєте, і з причин, які обираєте, — а також з минулих постів каналу, якщо ви поділитеся його історією. Ще в налаштуваннях можна описати, що канал публікує і що відсіває, і змінити це будь-коли. Що більше ви розглядаєте, то краще він сортує. Ми перевіряємо це на ваших власних рішеннях.',
      },
      {
        question: 'Що, як кілька джерел пишуть ту саму новину?',
        answer:
          'Вони збираються в одну історію й показуються однією карткою: угорі — версія з найвищою оцінкою, під нею — решта. Опублікуйте ту, що подобається, — інші відхиляться як уже висвітлені. Якщо історію вже опубліковано, картка про це скаже.',
      },
      {
        question: 'Що вміє AI-асистент?',
        answer:
          'У редакторі постів на сайті він переписує пост, як ви попросите, — коротше, іншим тоном, з кращим заголовком, з перекладеним підписом — і одразу показує зміну; скасувати можна одним кліком. Для перевірки фактів він шукає в інтернеті й каже, що підтверджується, а що ні, з посиланнями.',
      },
      {
        question: 'Це дослівний переклад?',
        answer:
          'Ні. Кожен пост переписується так, як написав би його ваш канал, — його мовою, тоном і форматом, — тримаючись фактів, цифр та імен оригіналу й нічого не додаючи від себе. Ви бачите кожен пост до публікації, а посилання на оригінал завжди поруч.',
      },
      {
        question: 'За якими джерелами можна стежити?',
        answer:
          'За публічними акаунтами X і Threads, RSS- і Atom-стрічками будь-яких сайтів, публічними Telegram- і YouTube-каналами та сайтами через їхні sitemap: нова стаття на сайті приходить постом із посиланням на неї. З X і Threads приходять пости з фото й відео, а пости без медіа можна ввімкнути для кожного акаунта окремо; репости пропускаються, а в X — ще й відповіді.',
      },
      {
        question: 'Куди можна публікувати?',
        answer:
          'У Telegram-канал і в акаунт Threads. Threads підключається на сайті, у власному вікні Meta — вашого пароля ми не бачимо, — а погоджуючи чи плануючи пост, ви обираєте Telegram, Threads або обидва. Threads приймає 500 символів, тож довший пост там скорочується; пост без картинок зберігає весь текст у вкладенні.',
      },
      {
        question: 'Чи можуть пости виходити без розгляду?',
        answer:
          'Так, окремо для кожного каналу. Канал, що репостить усе зі своїх джерел, може обійтися без розгляду — пости одразу виходять у Telegram-канал, переписані його мовою.',
      },
      {
        question: 'Чи потрібен мені власний доступ до X API?',
        answer:
          'Ні. Читання X і Threads — на нашому боці. Вам потрібні лише Telegram-канал із ботом-адміністратором і акаунт Threads, якщо публікуєте й туди.',
      },
      {
        question: 'Як швидко виходить новий пост?',
        answer:
          'Джерела перевіряються кожні 15 хвилин, а нові пости одразу йдуть у вашу чергу. У Telegram пост виходить, щойно ви його погодите, — або в запланований час, — а в Threads трохи згодом, коли Threads обробить його фото чи відео.',
      },
      {
        question: 'Чи з’явиться запланований пост у розділі «Відкладені» каналу?',
        answer:
          'Ні — Telegram не дозволяє ботам користуватися цим розділом. Розклад веде сам Zmistik і публікує пост протягом хвилини від обраного часу.',
      },
      {
        question: 'Скільки це коштує?',
        answer:
          'Вартість залежить від кількості каналів і джерел. Напишіть нам у Telegram — підберемо варіант.',
      },
    ],
  },
  cta: {
    title: 'Завтрашню чергу вже може бути розібрано.',
    text: 'Напишіть нам у Telegram — налаштуємо ваш канал, його мову й джерела для стеження.',
    button: 'Написати в Telegram',
  },
  footer: {
    disclaimer:
      'X, Telegram і Threads — торгові марки їхніх власників. Сервіс не пов’язаний з X Corp., Telegram чи Meta.',
    contact: 'Зв’язатися в Telegram',
    about: 'Про нас',
    privacy: 'Конфіденційність',
    terms: 'Умови',
  },
};

export const CONTENT: Record<Locale, LandingContent> = { en, uk };
