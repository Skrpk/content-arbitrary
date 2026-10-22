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
  hero: { eyebrow: string; title: string; lead: string; primary: string; secondary: string };
  mockup: {
    label: string;
    /** Three sources' posts on one event, as they were published, in English. */
    sourcesLabel: string;
    merged: string;
    /** Radar's one-line why, in the site's language. */
    reason: string;
    /** The lead post as the reviewer gets it, in the channel's language. */
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

const en: LandingContent = {
  meta: {
    title: 'An AI editorial desk for Telegram channels: your sources, ranked and rewritten in your voice',
    description:
      'Zmistik follows the X accounts, RSS feeds, Telegram and YouTube channels and websites you choose, ranks every new ' +
      'post by how likely you are to publish it, groups the same story from several sources into ' +
      'one card and rewrites it in your channel’s language and voice. You approve, edit with an AI ' +
      'assistant, schedule or reject — in Telegram or in the browser.',
    ogHeadline: 'An AI editorial desk for your Telegram channel',
    ogSubline: 'Your sources, ranked and rewritten in your voice — you decide',
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
    eyebrow: 'An AI editorial desk for Telegram channels',
    title: 'Everything your sources publish, sorted by what your channel would run',
    lead:
      'Zmistik follows the X accounts, RSS feeds, Telegram and YouTube channels and websites you pick. Each new post is ' +
      'scored by how likely you are to publish it, the same story from several sources becomes one ' +
      'card, and the text is rewritten in your channel’s language and voice. You only make the ' +
      'call: approve, edit, schedule or reject.',
    primary: 'Connect your channel',
    secondary: 'How it works',
  },
  mockup: {
    label: 'Three sources report one event, and it reaches the review queue as one ranked card',
    sourcesLabel: 'Three sources, one event',
    merged: 'One card in your queue, ranked and rewritten for a Spanish-language channel',
    reason: 'Record-breaking Webb news, like the posts you publish.',
    text: '🔭 Webb ha rastreado la ráfaga rápida de radio más lejana jamás detectada hasta su galaxia de origen.',
    textLang: 'es',
    caption: 'Best-scored first. Approve one, and the other two are marked as already covered.',
  },
  features: {
    title: 'From a stream of sources to your channel’s posts',
    lead: 'The reading, sorting, translating and re-uploading are done for you. What is left is the editorial decision.',
    items: [
      {
        icon: '📡',
        title: 'Best posts first',
        text: 'Every post gets a score: how likely you are to publish it. It learns from what you approve, the reasons you give when you reject, and what your channel has published before. You can also describe in Settings what your channel publishes and what it turns down. It sorts the queue; it never decides for you.',
      },
      {
        icon: '📚',
        title: 'One story, one card',
        text: 'When several sources report the same event, it arrives as one card: pick the best version, and the rest are set aside as already covered. A source posting the same thing again is marked 🔁.',
      },
      {
        icon: '🌐',
        title: 'In your channel’s language',
        text: 'Set your channel’s language once, and every post arrives already in it: rewritten the way a channel writes, not translated word for word. Facts, numbers and names stay as in the original.',
      },
      {
        icon: '🎙',
        title: 'In your channel’s voice',
        text: 'We import your channel’s past posts, and Zmistik picks up how it writes — tone, length, paragraphs, emoji — and writes new posts to match.',
      },
      {
        icon: '✨',
        title: 'An AI assistant in the editor',
        text: 'Ask “make it shorter” or “add context”, and the post changes in place — one click undoes it. Ask it to fact-check, and it searches the web and answers with sources.',
      },
      {
        icon: '🔌',
        title: 'Sources of every kind',
        text: 'Follow X accounts, RSS and Atom feeds, public Telegram and YouTube channels, and websites through their sitemaps — as many as you need for each channel, added in a click or with a command in the bot.',
      },
      {
        icon: '🗂',
        title: 'Review on your schedule',
        text: 'Posts wait in one queue, in Telegram or in the browser, and you get a note when new ones come in — every hour, once a day at the hour you choose, or post by post. Schedule any post for later.',
      },
      {
        icon: '🖼',
        title: 'Photos, videos, albums, no duplicates',
        text: 'Albums arrive as albums and videos in the best quality Telegram accepts. Add your own photo or video to any post in the editor. Nothing is published twice, and every post links back to its source.',
      },
    ],
  },
  steps: {
    title: 'How it works',
    lead: 'Setup takes a few minutes and needs no code.',
    items: [
      { title: 'Get in touch', text: 'We connect your channel, set its language and make you its editor.' },
      { title: 'Add the bot to your channel', text: 'Make the bot an admin of your Telegram channel with the right to post.' },
      {
        title: 'Pick sources, share your channel',
        text: 'Add X accounts, RSS feeds, Telegram and YouTube channels, and websites on the website or in the bot. Send us your channel’s export from Telegram Desktop, so ranking and rewriting learn from it.',
      },
      {
        title: 'Review and publish',
        text: 'Open the queue: the posts most likely to fit come first, already in your channel’s language. Approve, and it is published.',
      },
    ],
  },
  audiences: {
    title: 'Who it is for',
    items: [
      {
        title: 'Channels whose sources speak another language',
        text: 'Run a channel in your language on the best sources in English: posts arrive already rewritten, in your style.',
      },
      {
        title: 'News and niche channels',
        text: 'Follow every key source of your niche without drowning in it: the same news from ten accounts is one card, and the best of the day is at the top.',
      },
      {
        title: 'Channel networks',
        text: 'One service for several channels, each with its own sources, language, editor and rules — including channels that publish everything without review.',
      },
    ],
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
          'Public X accounts, RSS and Atom feeds of any site, public Telegram and YouTube channels, and websites through their sitemaps: a new article on the site arrives as a post that links to it. From X, posts with photos and videos come in, and posts without media can be switched on per account; reposts and replies are skipped.',
      },
      {
        question: 'Can posts go out without review?',
        answer:
          'Yes, per channel. A channel that reposts everything its sources publish can skip review, and posts go straight out — rewritten, in the channel’s language.',
      },
      {
        question: 'Do I need my own X API access?',
        answer: 'No. X access is on our side. All you need is a Telegram channel and the bot added to it as an admin.',
      },
      {
        question: 'How fast does a new post reach my channel?',
        answer:
          'Sources are checked every 15 minutes, and new posts go to your queue straight away. A post is published as soon as you approve it — or at the time you scheduled.',
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
    title: 'Connect your channel',
    text: 'Message us on Telegram — we will set up the bot, your channel’s language and the sources to follow.',
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
    title: 'AI-редакція для Telegram-каналу: ваші джерела, відсортовані й переписані вашим голосом',
    description:
      'Zmistik стежить за обраними акаунтами в X, RSS-стрічками, Telegram- і YouTube-каналами та сайтами, оцінює кожен ' +
      'новий пост за тим, наскільки ймовірно ви його опублікуєте, збирає ту саму історію з кількох ' +
      'джерел в одну картку й переписує її мовою та голосом вашого каналу. Ви погоджуєте, редагуєте ' +
      'з AI-асистентом, плануєте чи відхиляєте — у Telegram або в браузері.',
    ogHeadline: 'AI-редакція для вашого Telegram-каналу',
    ogSubline: 'Ваші джерела — відсортовані й переписані вашим голосом. Рішення за вами',
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
    eyebrow: 'AI-редакція для Telegram-каналів',
    title: 'Усе з ваших джерел — у порядку, який обрав би ваш канал',
    lead:
      'Zmistik стежить за обраними акаунтами в X, RSS-стрічками, Telegram- і YouTube-каналами та сайтами. Кожен новий ' +
      'пост отримує оцінку — наскільки ймовірно ви його опублікуєте, — та сама історія з кількох ' +
      'джерел стає однією карткою, а текст переписується мовою й голосом вашого каналу. Вам ' +
      'лишається тільки рішення: погодити, відредагувати, запланувати чи відхилити.',
    primary: 'Підключити канал',
    secondary: 'Як це працює',
  },
  mockup: {
    label: 'Три джерела пишуть про одну подію — і вона приходить у чергу однією оціненою карткою',
    sourcesLabel: 'Три джерела, одна подія',
    merged: 'Одна картка у вашій черзі — оцінена й переписана для україномовного каналу',
    reason: 'Рекордна новина від Webb — як ті, що ви публікуєте.',
    text: '🔭 Webb відстежив найвіддаленіший із відомих швидких радіосплесків до його рідної галактики.',
    textLang: 'uk',
    caption: 'Найкращі — першими. Погодите один — два інші позначаться як уже висвітлені.',
  },
  features: {
    title: 'Від потоку джерел до постів вашого каналу',
    lead: 'Читання, сортування, переклад і перезавантаження медіа — не ваша робота. Вам лишається редакторське рішення.',
    items: [
      {
        icon: '📡',
        title: 'Найкращі пости — першими',
        text: 'Кожен пост отримує оцінку: наскільки ймовірно ви його опублікуєте. Вона вчиться на тому, що ви погоджуєте, на причинах відмов і на тому, що канал публікував раніше. Свій канал ви також можете описати в налаштуваннях: що він публікує і що відсіває. Оцінка лише сортує чергу — рішень за вас не ухвалює.',
      },
      {
        icon: '📚',
        title: 'Одна історія — одна картка',
        text: 'Коли кілька джерел пишуть про ту саму подію, вона приходить однією карткою: оберіть найкращу версію, а решта відкладеться як уже висвітлена. Якщо джерело повторює той самий пост, він позначений 🔁.',
      },
      {
        icon: '🌐',
        title: 'Мовою вашого каналу',
        text: 'Вкажіть мову каналу один раз — і кожен пост приходить уже нею: переписаний так, як пише канал, а не перекладений дослівно. Факти, цифри й імена — як в оригіналі.',
      },
      {
        icon: '🎙',
        title: 'Голосом вашого каналу',
        text: 'Ми імпортуємо минулі пости каналу, і Zmistik переймає, як він пише, — тон, довжину, абзаци, емодзі — та пише нові пости так само.',
      },
      {
        icon: '✨',
        title: 'AI-асистент у редакторі',
        text: 'Попросіть «зроби коротше» чи «додай контекст» — і пост зміниться на місці, а скасувати можна одним кліком. Попросіть перевірити факти — асистент пошукає в інтернеті й відповість із джерелами.',
      },
      {
        icon: '🔌',
        title: 'Джерела будь-якого типу',
        text: 'Стежте за акаунтами X, RSS- і Atom-стрічками, публічними Telegram- і YouTube-каналами та сайтами через їхні sitemap — скільки треба для кожного каналу. Додаються одним кліком або командою в боті.',
      },
      {
        icon: '🗂',
        title: 'Розгляд у зручному ритмі',
        text: 'Пости чекають в одній черзі — у Telegram або в браузері, — а про нові ви дізнаєтеся тоді, коли зручно: щогодини, раз на день у вибрану годину чи кожен окремо. Будь-який пост можна запланувати.',
      },
      {
        icon: '🖼',
        title: 'Фото, відео, альбоми, без дублів',
        text: 'Альбоми приходять альбомами, відео — у найкращій якості, яку приймає Telegram. Додати власне фото чи відео можна прямо в редакторі поста. Нічого не вийде двічі, а під кожним постом — посилання на джерело.',
      },
    ],
  },
  steps: {
    title: 'Як це працює',
    lead: 'Налаштування займає кілька хвилин і не потребує коду.',
    items: [
      { title: 'Напишіть нам', text: 'Ми підключимо ваш канал, задамо його мову й зробимо вас його редактором.' },
      { title: 'Додайте бота в канал', text: 'Зробіть бота адміністратором свого Telegram-каналу з правом публікації.' },
      {
        title: 'Оберіть джерела й покажіть канал',
        text: 'Додайте акаунти X, RSS-стрічки, Telegram- і YouTube-канали та сайти на сайті або в боті. Надішліть нам експорт каналу з Telegram Desktop — оцінка й переписування вчитимуться на ньому.',
      },
      {
        title: 'Погоджуйте й публікуйте',
        text: 'Відкрийте чергу: першими — пости, які найімовірніше підійдуть, уже мовою вашого каналу. Погодили — і пост опубліковано.',
      },
    ],
  },
  audiences: {
    title: 'Для кого',
    items: [
      {
        title: 'Канали, чиї джерела пишуть іншою мовою',
        text: 'Ведіть український канал на найкращих англомовних джерелах: пости приходять уже переписаними, у вашому стилі.',
      },
      {
        title: 'Новинні й тематичні канали',
        text: 'Стежте за всіма ключовими джерелами ніші й не тоніть у них: та сама новина з десяти акаунтів — одна картка, а найкраще за день — угорі.',
      },
      {
        title: 'Мережі каналів',
        text: 'Один сервіс на кілька каналів: у кожного свої джерела, мова, редактор і правила — зокрема канали, що публікують усе без розгляду.',
      },
    ],
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
          'За публічними акаунтами X, RSS- і Atom-стрічками будь-яких сайтів, публічними Telegram- і YouTube-каналами та сайтами через їхні sitemap: нова стаття на сайті приходить постом із посиланням на неї. З X приходять пости з фото й відео, а пости без медіа можна ввімкнути для кожного акаунта окремо; репости й відповіді пропускаються.',
      },
      {
        question: 'Чи можуть пости виходити без розгляду?',
        answer:
          'Так, окремо для кожного каналу. Канал, що репостить усе зі своїх джерел, може обійтися без розгляду — пости виходять одразу, переписані мовою каналу.',
      },
      {
        question: 'Чи потрібен мені власний доступ до X API?',
        answer: 'Ні. Доступ до X — на нашому боці. Вам потрібні лише Telegram-канал і бот, доданий у нього адміністратором.',
      },
      {
        question: 'Як швидко новий пост потрапляє в канал?',
        answer:
          'Джерела перевіряються кожні 15 хвилин, а нові пости одразу йдуть у вашу чергу. У канал пост виходить, щойно ви його погодите, — або в запланований час.',
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
    title: 'Підключіть свій канал',
    text: 'Напишіть нам у Telegram — налаштуємо бота, мову каналу й джерела для стеження.',
    button: 'Написати в Telegram',
  },
  footer: {
    disclaimer:
      'X — торгова марка X Corp., Telegram — Telegram FZ-LLC. Сервіс не пов’язаний із ними.',
    contact: 'Зв’язатися в Telegram',
  },
};

export const CONTENT: Record<Locale, LandingContent> = { en, uk };
