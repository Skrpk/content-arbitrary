import type { PublicPage } from './shared';

/**
 * A page for each thing people come looking for: getting a kind of source into
 * a Telegram channel, translating, scheduling. Each answers its own question
 * and says its own limits, written for that question and not filled into a
 * template: search engines pass over pages that differ only in a word.
 *
 * As everywhere on the site, only what the product does today.
 */

const rss = {
  en: {
    title: 'RSS to Telegram channel, with review',
    description: 'Send new RSS and Atom feed entries to your Telegram channel, scored, in your language, and only once you approve them.',
    body: (
      <>
        <p>
          Zmistik watches the RSS and Atom feeds you choose and brings every new entry to you as a ready post for your Telegram
          channel. Unlike a plain RSS bot, it does not pour everything into the channel: entries are scored, the same news from
          several feeds becomes one card, and you decide what goes out.
        </p>

        <h2>How it works</h2>
        <ol>
          <li>Add the feed’s URL on the Sources page or with <code>/addrss</code> in the bot. RSS 2.0 and Atom both work.</li>
          <li>What is in the feed at that moment is not sent. From then on, only new entries come through.</li>
          <li>Feeds are checked every 15 minutes. Each new entry gets a score and is rewritten in your channel’s language.</li>
          <li>You approve, edit, schedule or reject it, in Telegram or in the browser.</li>
        </ol>

        <h2>What a post looks like</h2>
        <p>
          The entry’s title and summary as text, with the article’s link under it. Telegram draws the link’s preview card, and that
          card is the post’s picture.
        </p>

        <h2>Less noise from busy feeds</h2>
        <p>
          News feeds publish far more than a channel can use. The queue puts first what your channel is most likely to run, and you can
          set a score threshold for a feed, so that entries under it never reach review. If a channel really should repost everything,
          it can publish without review.
        </p>

        <h2>Good to know</h2>
        <ul>
          <li>You need the feed’s own URL, not the site’s home page: feeds are not searched for.</li>
          <li>Only what the feed itself says is used. For whole articles, follow the site through its sitemap instead.</li>
          <li>Pictures and attachments from the feed are not sent as media.</li>
        </ul>
      </>
    ),
  },
  uk: {
    title: 'RSS у Telegram-канал із рев’ю',
    description: 'Нові записи RSS- і Atom-стрічок у вашому Telegram-каналі: з оцінкою, вашою мовою і лише після вашого схвалення.',
    body: (
      <>
        <p>
          Zmistik стежить за обраними RSS- і Atom-стрічками й приносить кожен новий запис як готовий пост для вашого Telegram-каналу.
          На відміну від звичайного RSS-бота, він не зливає в канал усе підряд: записи отримують оцінку, та сама новина з кількох стрічок
          стає однією карткою, а що вийде, вирішуєте ви.
        </p>

        <h2>Як це працює</h2>
        <ol>
          <li>Додайте URL стрічки на сторінці Sources або командою <code>/addrss</code> у боті. Підходять RSS 2.0 і Atom.</li>
          <li>Те, що вже є в стрічці, не надсилається. Далі приходять лише нові записи.</li>
          <li>Стрічки перевіряються кожні 15 хвилин. Кожен новий запис отримує оцінку й переписується мовою каналу.</li>
          <li>Ви погоджуєте, редагуєте, плануєте чи відхиляєте його в Telegram або в браузері.</li>
        </ol>

        <h2>Який вигляд має пост</h2>
        <p>
          Текст — це заголовок і опис запису, під ним посилання на статтю. Telegram показує картку-прев’ю цього посилання, і вона стає
          картинкою поста.
        </p>

        <h2>Менше шуму від активних стрічок</h2>
        <p>
          Новинні стрічки публікують набагато більше, ніж потрібно каналу. Черга ставить першим те, що ваш канал опублікує
          найімовірніше, а для стрічки можна задати поріг оцінки: записи нижче нього до рев’ю не доходять. Якщо канал справді має
          публікувати все, він може працювати без рев’ю.
        </p>

        <h2>Варто знати</h2>
        <ul>
          <li>Потрібен URL самої стрічки, а не головної сторінки сайту: стрічки сервіс не шукає.</li>
          <li>Береться лише те, що є в стрічці. Щоб отримувати цілі статті, додайте сайт через sitemap.</li>
          <li>Картинки й вкладення зі стрічки не надсилаються як медіа.</li>
        </ul>
      </>
    ),
  },
} satisfies Record<'en' | 'uk', PublicPage>;

const x = {
  en: {
    title: 'X (Twitter) to Telegram channel',
    description: 'Bring new posts from X accounts to your Telegram channel with their photos and videos, translated, and published once you approve.',
    body: (
      <>
        <p>
          Zmistik follows the X accounts you pick and brings their new posts to your Telegram channel, photos and videos included. Each
          post is scored and rewritten in your channel’s language, and it goes out when you approve it. You do not need your own X API
          access.
        </p>

        <h2>How it works</h2>
        <ol>
          <li>Add an account as <code>@username</code> or an x.com link on the Sources page, or with <code>/addsource</code> in the bot.</li>
          <li>What the account posted before is not sent. Only posts from then on come through.</li>
          <li>Accounts are checked every 15 minutes, and new posts arrive in the order they were written.</li>
          <li>You approve, edit, schedule or reject each one, in Telegram or in the browser.</li>
        </ol>

        <h2>What comes through</h2>
        <ul>
          <li>Posts with photos and videos, sent to Telegram as real media: one photo, one video or an album.</li>
          <li>Text-only posts too, once you switch that on for the account in its settings.</li>
          <li>Whole long posts, not X’s cut-off version. Shortened links are replaced with the real ones.</li>
        </ul>

        <h2>When several accounts post the same thing</h2>
        <p>
          The same event from several accounts arrives as one card. You pick the version you like, and the rest are set aside as already
          covered. A source repeating a post it sent before is marked as a repeat.
        </p>

        <h2>Good to know</h2>
        <ul>
          <li>Only public accounts can be followed.</li>
          <li>Replies and reposts are skipped.</li>
          <li>A post whose media cannot be sent is skipped, not published as bare text, which would misrepresent it.</li>
        </ul>
      </>
    ),
  },
  uk: {
    title: 'X (Twitter) у Telegram-канал',
    description: 'Нові пости з акаунтів X у вашому Telegram-каналі: з фото й відео, у перекладі й лише після вашого схвалення.',
    body: (
      <>
        <p>
          Zmistik стежить за обраними акаунтами X і приносить їхні нові пости у ваш Telegram-канал разом із фото й відео. Кожен пост
          отримує оцінку, переписується мовою каналу й виходить після вашого схвалення. Власний доступ до X API не потрібен.
        </p>

        <h2>Як це працює</h2>
        <ol>
          <li>Додайте акаунт як <code>@username</code> або посилання на x.com на сторінці Sources чи командою <code>/addsource</code> у боті.</li>
          <li>Те, що акаунт опублікував раніше, не надсилається. Приходять лише нові пости.</li>
          <li>Акаунти перевіряються кожні 15 хвилин, а нові пости приходять у тому порядку, в якому написані.</li>
          <li>Ви погоджуєте, редагуєте, плануєте чи відхиляєте кожен із них у Telegram або в браузері.</li>
        </ol>

        <h2>Що приходить</h2>
        <ul>
          <li>Пости з фото й відео, які йдуть у Telegram справжніми медіа: одне фото, одне відео або альбом.</li>
          <li>Текстові пости теж, якщо ввімкнути це в налаштуваннях акаунта.</li>
          <li>Довгі пости цілком, а не обрізана версія X. Скорочені посилання замінюються на справжні.</li>
        </ul>

        <h2>Коли кілька акаунтів пишуть про те саме</h2>
        <p>
          Та сама подія з кількох акаунтів приходить однією карткою. Ви обираєте версію, яка подобається, а решта відкладаються як уже
          висвітлені. Якщо джерело повторює свій попередній пост, він позначається як повтор.
        </p>

        <h2>Варто знати</h2>
        <ul>
          <li>Стежити можна лише за публічними акаунтами.</li>
          <li>Відповіді й репости пропускаються.</li>
          <li>Пост, медіа якого не вдається надіслати, пропускається: без них він викривив би зміст.</li>
        </ul>
      </>
    ),
  },
} satisfies Record<'en' | 'uk', PublicPage>;

const youtube = {
  en: {
    title: 'YouTube to Telegram channel',
    description: 'New videos from YouTube channels as ready posts for your Telegram channel, in your language, with the video’s link and player.',
    body: (
      <>
        <p>
          Zmistik follows public YouTube channels and turns each new video into a ready post for your Telegram channel: what the video
          is and what it covers, in your channel’s language, with its link. Telegram shows YouTube’s own player in the preview.
        </p>

        <h2>How it works</h2>
        <ol>
          <li>Add a channel as <code>@handle</code> or a youtube.com link on the Sources page, or with <code>/addyoutube</code> in the bot.</li>
          <li>Videos published before that are not sent. Only new ones come through.</li>
          <li>Each new video is scored for your channel and comes to review as a post.</li>
          <li>You approve, edit, schedule or reject it, in Telegram or in the browser.</li>
        </ol>

        <h2>Judged by what is said, not by the title</h2>
        <p>
          When a video has a transcript, the score reads it, so a clickbait title does not decide what the video is about. The transcript
          is for analysis only, and is not published as it is. It also groups the video with posts on the same event from your other sources.
        </p>

        <h2>Good to know</h2>
        <ul>
          <li>The video itself is never downloaded: the post goes out as text and a link.</li>
          <li>You follow channels, not single videos.</li>
          <li>A premiere waits until it is out.</li>
          <li>A video without a transcript still comes through, judged by its title and description.</li>
        </ul>
      </>
    ),
  },
  uk: {
    title: 'YouTube у Telegram-канал',
    description: 'Нові відео з YouTube-каналів як готові пости для вашого Telegram-каналу: вашою мовою, з посиланням і плеєром.',
    body: (
      <>
        <p>
          Zmistik стежить за публічними YouTube-каналами й перетворює кожне нове відео на готовий пост для вашого Telegram-каналу: що це
          за відео і про що воно, мовою вашого каналу, з посиланням. У прев’ю Telegram показує плеєр YouTube.
        </p>

        <h2>Як це працює</h2>
        <ol>
          <li>Додайте канал як <code>@handle</code> або посилання на youtube.com на сторінці Sources чи командою <code>/addyoutube</code> у боті.</li>
          <li>Відео, опубліковані раніше, не надсилаються. Приходять лише нові.</li>
          <li>Кожне нове відео отримує оцінку для вашого каналу й приходить на рев’ю як пост.</li>
          <li>Ви погоджуєте, редагуєте, плануєте чи відхиляєте його в Telegram або в браузері.</li>
        </ol>

        <h2>Оцінка за змістом, а не за заголовком</h2>
        <p>
          Якщо відео має транскрипт, оцінка спирається на нього, тож клікбейтний заголовок не вирішує, про що відео. Транскрипт потрібен для
          аналізу й не публікується як є. Завдяки йому відео також групується з постами про ту саму подію з інших ваших джерел.
        </p>

        <h2>Варто знати</h2>
        <ul>
          <li>Саме відео ніколи не завантажується: пост виходить як текст і посилання.</li>
          <li>Стежити можна за каналами, а не за окремими відео.</li>
          <li>Прем’єра чекає, доки вийде.</li>
          <li>Відео без транскрипту теж приходить, його оцінюють за назвою й описом.</li>
        </ul>
      </>
    ),
  },
} satisfies Record<'en' | 'uk', PublicPage>;

const website = {
  en: {
    title: 'Website articles to a Telegram channel',
    description: 'Follow any news site or blog through its sitemap and get each new article as a ready post for your Telegram channel, even without RSS.',
    body: (
      <>
        <p>
          Many sites have no RSS feed, or one that says too little. Zmistik follows a site through its sitemap, finds new pages, reads the
          article on each and brings it to you as a post for your Telegram channel: its title and lead, with the link.
        </p>

        <h2>How it works</h2>
        <ol>
          <li>Give the sitemap’s URL on the Sources page or with <code>/addwebsite</code> in the bot. A sitemap index and <code>.xml.gz</code> work too.</li>
          <li>Pages already listed are ignored. Only pages that appear from then on come through.</li>
          <li>Only new pages are fetched, and the article is read from each.</li>
          <li>A page that is not an article, such as a category or an author’s page, is passed over.</li>
          <li>The rest are scored and come to review, in your channel’s language.</li>
        </ol>

        <h2>The whole article counts</h2>
        <p>
          The post itself is short, but the score reads the whole article, not only its opening. The same text groups it with what your
          other sources say about the same event, so a story from a site, X and YouTube is one card.
        </p>

        <h2>Good to know</h2>
        <ul>
          <li>You give the sitemap’s address yourself: it is not searched for.</li>
          <li>Sites that show articles only through JavaScript cannot be read.</li>
          <li>Paywalls, logins and anti-bot walls are not bypassed. Only what the site shows to anyone is read.</li>
          <li>The article’s pictures are not sent. The post goes out with its link, and Telegram draws the preview.</li>
          <li>If a site has a separate news or posts sitemap, use that one: it means fewer pages fetched for nothing.</li>
        </ul>
      </>
    ),
  },
  uk: {
    title: 'Статті із сайту в Telegram-канал',
    description: 'Стежте за новинним сайтом чи блогом через sitemap і отримуйте кожну нову статтю як готовий пост для Telegram-каналу навіть без RSS.',
    body: (
      <>
        <p>
          Багато сайтів не мають RSS-стрічки або вона надто скупа. Zmistik стежить за сайтом через його sitemap, знаходить нові сторінки,
          читає на кожній статтю й приносить її як пост для вашого Telegram-каналу: заголовок і лід із посиланням.
        </p>

        <h2>Як це працює</h2>
        <ol>
          <li>Вкажіть URL sitemap на сторінці Sources або командою <code>/addwebsite</code> у боті. Підходять sitemap index і <code>.xml.gz</code>.</li>
          <li>Сторінки, які вже є в sitemap, ігноруються. Приходять лише ті, що з’являться потім.</li>
          <li>Завантажуються лише нові сторінки, і з кожної читається стаття.</li>
          <li>Сторінка, яка не є статтею, наприклад категорія чи сторінка автора, пропускається.</li>
          <li>Решта отримують оцінку й приходять на рев’ю мовою вашого каналу.</li>
        </ol>

        <h2>Важлива вся стаття</h2>
        <p>
          Сам пост короткий, але оцінка читає всю статтю, а не лише початок. Той самий текст групує її з тим, що про цю подію пишуть інші
          ваші джерела, тож новина із сайту, X і YouTube стає однією карткою.
        </p>

        <h2>Варто знати</h2>
        <ul>
          <li>Адресу sitemap вказуєте ви: сервіс її не шукає.</li>
          <li>Сайти, що показують статті лише через JavaScript, прочитати не вдасться.</li>
          <li>Платний доступ, логін і захист від ботів не обходяться. Читається лише те, що сайт показує всім.</li>
          <li>Картинки зі статті не надсилаються. Пост виходить із посиланням, а прев’ю показує Telegram.</li>
          <li>Якщо сайт має окремий sitemap новин чи постів, беріть його: так менше зайвих завантажень.</li>
        </ul>
      </>
    ),
  },
} satisfies Record<'en' | 'uk', PublicPage>;

const translate = {
  en: {
    title: 'Translate posts for a Telegram channel',
    description: 'Every post from your sources arrives rewritten in your channel’s language and voice, with facts, numbers and names kept as in the original.',
    body: (
      <>
        <p>
          If your sources write in one language and your channel in another, Zmistik does the translating for you. Every post arrives
          already in your channel’s language, ready to approve or edit, and the original is one tap away.
        </p>

        <h2>Rewritten, not translated word for word</h2>
        <p>
          Each post is written the way a channel would write it, not as a literal translation. Facts, numbers and names stay as in the
          original, nothing is added, and links are left as they are.
        </p>

        <h2>In your channel’s voice</h2>
        <p>
          If you share your channel’s past posts, Zmistik picks up how it writes, from tone and length to paragraphs and emoji, and writes
          new posts to match.
        </p>

        <h2>How it works</h2>
        <ol>
          <li>Your channel’s language is set once, when it is connected.</li>
          <li>New posts from any source are rewritten in it before they reach review.</li>
          <li>You see the ready text with a link to the original, and approve or edit it.</li>
          <li>In the website’s editor, an AI assistant changes the text on request: shorter, another tone, a better headline.</li>
        </ol>

        <h2>Good to know</h2>
        <ul>
          <li>A post already in your channel’s language is left as it is.</li>
          <li>If a translation fails, the post comes in its own language rather than getting lost.</li>
          <li>The text is written by AI. Check important facts before publishing.</li>
        </ul>
      </>
    ),
  },
  uk: {
    title: 'Переклад постів для Telegram-каналу',
    description: 'Кожен пост із ваших джерел приходить переписаним мовою й голосом каналу, а факти, цифри та імена лишаються як в оригіналі.',
    body: (
      <>
        <p>
          Якщо джерела пишуть однією мовою, а ваш канал іншою, Zmistik перекладає за вас. Кожен пост приходить уже мовою каналу, готовий до
          схвалення чи правок, а оригінал за одне натискання.
        </p>

        <h2>Переписує, а не перекладає слово в слово</h2>
        <p>
          Кожен пост написаний так, як його написав би канал, а не як дослівний переклад. Факти, цифри й імена лишаються як в оригіналі,
          нічого не додається, а посилання не змінюються.
        </p>

        <h2>Голосом вашого каналу</h2>
        <p>
          Якщо ви поділитеся минулими постами каналу, Zmistik вловить, як він пише, від тону й довжини до абзаців та емодзі, і писатиме нові
          пости так само.
        </p>

        <h2>Як це працює</h2>
        <ol>
          <li>Мова каналу задається один раз, під час підключення.</li>
          <li>Нові пости з будь-якого джерела переписуються нею ще до рев’ю.</li>
          <li>Ви бачите готовий текст із посиланням на оригінал і погоджуєте чи правите його.</li>
          <li>У редакторі на сайті AI-асистент змінює текст на прохання: коротше, в іншому тоні, з кращим заголовком.</li>
        </ol>

        <h2>Варто знати</h2>
        <ul>
          <li>Пост, який уже написаний мовою каналу, лишається як є.</li>
          <li>Якщо переклад не вдався, пост приходить своєю мовою, а не губиться.</li>
          <li>Текст пише AI. Важливі факти перевіряйте перед публікацією.</li>
        </ul>
      </>
    ),
  },
} satisfies Record<'en' | 'uk', PublicPage>;

const schedule = {
  en: {
    title: 'Schedule posts in a Telegram channel',
    description: 'Pick a time for each post, see the whole plan by day, and edit or move a scheduled post until it goes out, in Telegram or the browser.',
    body: (
      <>
        <p>
          Zmistik lets you schedule posts for your Telegram channel right from the review queue. Pick a time, and the post goes out then,
          within a minute. Until that moment you can still change its text and its time.
        </p>

        <h2>How it works</h2>
        <ol>
          <li>Press Schedule on a post in review, in Telegram or on the website.</li>
          <li>Choose a date and time in your own time zone, or a shortcut: in an hour, tonight, tomorrow morning.</li>
          <li>The post waits in the Scheduled list and is published at that time.</li>
        </ol>

        <h2>The whole plan in one place</h2>
        <p>
          The Scheduled page on the website shows what is waiting, day by day, with each post’s pictures, text and how long is left. In the
          bot, <code>/scheduled</code> gives the same list.
        </p>

        <h2>Nothing is final until it goes out</h2>
        <ul>
          <li>Edit the text: whatever was saved by then is what is published.</li>
          <li>Change the time, and the list re-sorts.</li>
          <li>Send it back to review if you change your mind.</li>
          <li>Or publish it right away from the bot.</li>
        </ul>

        <h2>Good to know</h2>
        <ul>
          <li>
            Telegram does not let bots use a channel’s own scheduled messages, so these posts are not in the channel’s Scheduled list in
            Telegram. They wait in Zmistik.
          </li>
          <li>If publishing fails, it is tried again. If it keeps failing, the post returns to review with the reason.</li>
        </ul>
      </>
    ),
  },
  uk: {
    title: 'Відкладені пости для Telegram-каналу',
    description: 'Обирайте час для кожного поста, бачте весь план по днях і правте чи переносьте відкладений пост, доки він не вийшов.',
    body: (
      <>
        <p>
          Zmistik дозволяє відкладати пости для Telegram-каналу просто з черги рев’ю. Оберіть час, і пост вийде тоді, з точністю до хвилини.
          До цього моменту його текст і час ще можна змінити.
        </p>

        <h2>Як це працює</h2>
        <ol>
          <li>Натисніть Schedule на пості в черзі, у Telegram або на сайті.</li>
          <li>Оберіть дату й час у своєму часовому поясі або готовий варіант: за годину, сьогодні ввечері, завтра вранці.</li>
          <li>Пост чекає у списку Scheduled і виходить у вказаний час.</li>
        </ol>

        <h2>Увесь план в одному місці</h2>
        <p>
          Сторінка Scheduled на сайті показує, що чекає на публікацію, по днях: картинки, текст і скільки лишилося часу. У боті той самий
          список дає команда <code>/scheduled</code>.
        </p>

        <h2>Усе можна змінити, доки пост не вийшов</h2>
        <ul>
          <li>Правте текст: вийде те, що збережено на цей момент.</li>
          <li>Змініть час, і список пересортується.</li>
          <li>Поверніть пост на рев’ю, якщо передумали.</li>
          <li>Або опублікуйте його одразу з бота.</li>
        </ul>

        <h2>Варто знати</h2>
        <ul>
          <li>
            Telegram не дає ботам користуватися власними відкладеними повідомленнями каналу, тому цих постів немає у списку відкладених у
            самому Telegram. Вони чекають у Zmistik.
          </li>
          <li>Якщо публікація не вдалася, вона повторюється. Якщо не вдається знову й знову, пост повертається на рев’ю з причиною.</li>
        </ul>
      </>
    ),
  },
} satisfies Record<'en' | 'uk', PublicPage>;

/** Most searched for first: the order the landing and each page list them in. */
export const USE_CASE_PAGES = {
  'rss-to-telegram': rss,
  'schedule-telegram-posts': schedule,
  'x-to-telegram': x,
  'translate-telegram-posts': translate,
  'youtube-to-telegram': youtube,
  'website-to-telegram': website,
};

export type UseCaseKey = keyof typeof USE_CASE_PAGES;
export const USE_CASE_KEYS = Object.keys(USE_CASE_PAGES) as UseCaseKey[];
