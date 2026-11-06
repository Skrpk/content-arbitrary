import Link from 'next/link';
import type { ReactNode } from 'react';
import { localePath, type Locale } from '../i18n';
import { Contact, type PublicPage } from './shared';

/**
 * The privacy policy. Everything said here is what the code does: change what
 * is stored, who it goes to or how long it is kept, and this changes with it.
 * The operator is the service's name until there is a legal entity to name.
 */

const YOUTUBE_TERMS = 'https://www.youtube.com/t/terms';
const GOOGLE_PRIVACY = 'https://policies.google.com/privacy';

const en: PublicPage = {
  title: 'Privacy Policy',
  description: 'What data Zmistik processes, why, who it goes to, how long it is kept and what your rights are.',
  effective: 'In effect from 6 November 2026.',
  body: (
    <>
      <p>
        Zmistik helps people who run Telegram channels find, assess, prepare and publish posts. This policy explains what
        data we process, why, who we share it with and what rights you have.
      </p>

      <h2>1. Who we are</h2>
      <p>
        The service is operated by Zmistik (zmistik.com). Send anything about your data to <Contact /> on Telegram.
      </p>

      <h2>2. What data we process</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>What exactly</th>
              <th>Where it comes from</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Account</td>
              <td>Telegram ID, name, username, time of last sign-in</td>
              <td>Telegram, when you sign in or open the Mini App</td>
            </tr>
            <tr>
              <td>Session</td>
              <td>A hash of the session token, last activity, your browser’s description (User-Agent)</td>
              <td>Your browser</td>
            </tr>
            <tr>
              <td>Channel settings</td>
              <td>Channel ID and name, reviewer ID, editorial profile, language, post footer, notification settings</td>
              <td>You</td>
            </tr>
            <tr>
              <td>Sources</td>
              <td>The X accounts, RSS feeds, Telegram and YouTube channels and website sitemaps you chose</td>
              <td>You</td>
            </tr>
            <tr>
              <td>Editorial activity</td>
              <td>Decisions on posts, rejection reasons and notes, edits, publication times, time zone</td>
              <td>You</td>
            </tr>
            <tr>
              <td>Uploaded files</td>
              <td>Photos and videos added in the editor</td>
              <td>You</td>
            </tr>
            <tr>
              <td>Channel history</td>
              <td>Past posts, if you provide their export, and the channel profile made from them</td>
              <td>You</td>
            </tr>
            <tr>
              <td>AI assistant use</td>
              <td>Who asked and when, for which post, the model, the size and cost of the request, the outcome</td>
              <td>The service</td>
            </tr>
            <tr>
              <td>Technical logs</td>
              <td>Events and errors in the service’s work</td>
              <td>The service</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        We do not ask for a password: you sign in through Telegram. We do not process payment details, as the service takes
        no payments for now.
      </p>

      <h2>3. Content from public sources</h2>
      <p>
        The service reads public posts, articles, videos and their descriptions from the sources you choose, and stores
        their text, links, details of their media, public counts and video transcripts. Such material may contain the names
        or other details of the people it is about. We process it only to show it to you, assess it and prepare a post. If
        you find data about yourself in the service and want it removed, write to <Contact />.
      </p>

      <h2>4. Why we process it</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Purpose</th>
              <th>Legal basis</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Sign-in, running your channels, the review queue, publishing</td>
              <td>Performing our contract with you</td>
            </tr>
            <tr>
              <td>Scoring posts, grouping stories, translating and rewriting, the AI assistant</td>
              <td>Performing our contract with you</td>
            </tr>
            <tr>
              <td>Protecting the service, fixing faults, keeping costs under control</td>
              <td>Legitimate interest</td>
            </tr>
            <tr>
              <td>Meeting legal requirements</td>
              <td>Legal obligation</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        A post’s score is only a hint: it sets the order of the queue and does not decide what is published. If you turn on
        publishing without review for a channel, posts go out automatically, as you set it.
      </p>

      <h2>5. How we use AI</h2>
      <p>
        We send AI providers post texts, descriptions and images of posts, transcripts, samples of articles, the editorial
        profile and your earlier decisions, as well as what you ask the AI assistant. This is needed for scoring, translation,
        describing images, finding similar posts and the assistant’s work. We do not keep your conversation with the
        assistant: it exists while the editor is open.
      </p>
      <p>
        Your decisions and your channel’s history are used for suggestions in your channel. We do not use them for suggestions
        to other customers.
      </p>

      <h2>6. Who we share data with</h2>
      <p>
        We do not sell personal data or use it for advertising. It goes only to the providers the service cannot work without:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>What for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Vercel</td>
              <td>Hosting, logs, storage of uploaded files, anonymous visit statistics for the public pages</td>
            </tr>
            <tr>
              <td>Neon</td>
              <td>The database</td>
            </tr>
            <tr>
              <td>OpenAI</td>
              <td>Scoring posts, translation, embeddings, describing images, the AI assistant</td>
            </tr>
            <tr>
              <td>Anthropic</td>
              <td>May be used as an alternative AI provider</td>
            </tr>
            <tr>
              <td>Telegram</td>
              <td>Sign-in, the bot, the Mini App, publishing posts</td>
            </tr>
            <tr>
              <td>Supadata</td>
              <td>Video transcripts, by the link to a public video</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        To read sources we call the X API, the YouTube Data API, RSS feeds and public websites. These requests carry none of
        your personal data: they concern only the sources chosen.
      </p>
      <p>
        The service’s functions and database run in Frankfurt. Some providers are outside the European Economic Area, so data
        may be transferred outside it. We may disclose data where the law requires it.
      </p>

      <h2>7. YouTube</h2>
      <p>
        The service uses YouTube API Services. By using YouTube sources you agree to the{' '}
        <a href={YOUTUBE_TERMS} rel="noopener">YouTube Terms of Service</a>. Data is also handled under the{' '}
        <a href={GOOGLE_PRIVACY} rel="noopener">Google Privacy Policy</a>. The service reads only public data of channels and
        videos and has no access to your Google account.
      </p>

      <h2>8. Cookies</h2>
      <p>We use only the cookies the service needs:</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Cookie</th>
              <th>What for</th>
              <th>How long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>__Host-session</code>
              </td>
              <td>Keeps you signed in on the review website</td>
              <td>30 days</td>
            </tr>
            <tr>
              <td>Sign-in state</td>
              <td>Protects signing in through Telegram</td>
              <td>10 minutes</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>There are no advertising or analytics cookies on the site. We count visits to the public pages with Vercel Web Analytics, which sets no cookies and gives us aggregated statistics only.</p>

      <h2>9. How long we keep data</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>How long</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Session</td>
              <td>Up to 30 days, or until you sign out</td>
            </tr>
            <tr>
              <td>Sign-in attempt</td>
              <td>Up to 10 minutes</td>
            </tr>
            <tr>
              <td>Uploaded files</td>
              <td>Deleted from storage soon after the post is published or rejected</td>
            </tr>
            <tr>
              <td>Conversation with the AI assistant</td>
              <td>Not kept</td>
            </tr>
            <tr>
              <td>Account, settings, posts, decisions, channel history</td>
              <td>While the channel uses the service, or until you ask us to delete them</td>
            </tr>
            <tr>
              <td>Technical logs</td>
              <td>A limited time set by our hosting provider</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Removing a source does not remove the posts it already brought in. To delete them, write to us. What has been
        published in your Telegram channel is controlled by you and Telegram, not by us.
      </p>

      <h2>10. Your rights</h2>
      <p>
        You may ask for access to your data, its correction or deletion, restriction of its processing and a copy of it. You
        may object to processing based on legitimate interest. Write to <Contact /> and we will answer within 30 days. You may
        also complain to the data protection authority in your country.
      </p>

      <h2>11. Security</h2>
      <p>
        Connections to the service are encrypted. Session tokens are stored only as hashes, and secrets are removed from logs.
        No protection is absolute; if a breach affects you, we will tell you as the law requires.
      </p>

      <h2>12. Children</h2>
      <p>The service is for people aged 16 and over. We do not knowingly collect children’s data.</p>

      <h2>13. Changes</h2>
      <p>
        We may update this policy. We will announce material changes on the site or through the bot and update the date at the
        top of this page.
      </p>
    </>
  ),
};

const uk: PublicPage = {
  title: 'Політика конфіденційності',
  description: 'Які дані обробляє Zmistik, навіщо, кому передає, як довго зберігає і які права ви маєте.',
  effective: 'Чинна з 6 листопада 2026 року.',
  body: (
    <>
      <p>
        Zmistik — сервіс, який допомагає адміністраторам Telegram-каналів знаходити, оцінювати, готувати й публікувати пости.
        Ця політика пояснює, які дані ми обробляємо, навіщо, кому передаємо і які права ви маєте.
      </p>

      <h2>1. Хто ми</h2>
      <p>
        Оператор сервісу — Zmistik (zmistik.com). Запити щодо даних надсилайте в Telegram: <Contact />.
      </p>

      <h2>2. Які дані ми обробляємо</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Дані</th>
              <th>Що саме</th>
              <th>Звідки</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Акаунт</td>
              <td>Telegram ID, ім’я, username, час останнього входу</td>
              <td>Telegram, коли ви входите на сайт або відкриваєте Mini App</td>
            </tr>
            <tr>
              <td>Сесія</td>
              <td>Хеш токена сесії, час останньої активності, опис браузера (User-Agent)</td>
              <td>Ваш браузер</td>
            </tr>
            <tr>
              <td>Налаштування каналу</td>
              <td>Ідентифікатор і назва каналу, ідентифікатор рев’юера, редакційний профіль, мова, футер постів, налаштування сповіщень</td>
              <td>Ви</td>
            </tr>
            <tr>
              <td>Джерела</td>
              <td>Обрані акаунти X, RSS-стрічки, канали Telegram і YouTube, sitemap сайтів</td>
              <td>Ви</td>
            </tr>
            <tr>
              <td>Редакційні дії</td>
              <td>Рішення щодо постів, причини й нотатки до відхилень, правки текстів, час публікації, часовий пояс</td>
              <td>Ви</td>
            </tr>
            <tr>
              <td>Завантажені файли</td>
              <td>Фото й відео, додані в редакторі</td>
              <td>Ви</td>
            </tr>
            <tr>
              <td>Історія каналу</td>
              <td>Минулі пости, якщо ви надали їхній експорт, і створений з них профіль каналу</td>
              <td>Ви</td>
            </tr>
            <tr>
              <td>Використання AI-асистента</td>
              <td>Хто й коли звернувся, до якого поста, модель, обсяг і вартість запиту, результат</td>
              <td>Сервіс</td>
            </tr>
            <tr>
              <td>Технічні журнали</td>
              <td>Події роботи сервісу й помилки</td>
              <td>Сервіс</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Ми не просимо пароль: вхід відбувається через Telegram. Ми не обробляємо платіжні дані, бо сервіс поки не бере оплату.
      </p>

      <h2>3. Контент із публічних джерел</h2>
      <p>
        Сервіс читає публічні пости, статті, відео та їхні описи з обраних вами джерел і зберігає їхній текст, посилання,
        відомості про медіа, публічні показники й транскрипти відео. Такі матеріали можуть містити імена чи інші дані людей,
        про яких у них ідеться. Ми обробляємо їх лише для того, щоб показати вам матеріал, оцінити його й підготувати пост.
        Якщо ви бачите в сервісі дані про себе й хочете їх прибрати, напишіть <Contact />.
      </p>

      <h2>4. Навіщо ми це робимо</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Мета</th>
              <th>Правова підстава</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Вхід, робота каналів, черга рев’ю, публікація</td>
              <td>Виконання договору з вами</td>
            </tr>
            <tr>
              <td>Оцінка постів, групування новин, переклад, переписування, AI-асистент</td>
              <td>Виконання договору з вами</td>
            </tr>
            <tr>
              <td>Захист сервісу, усунення помилок, контроль витрат</td>
              <td>Законний інтерес</td>
            </tr>
            <tr>
              <td>Виконання вимог закону</td>
              <td>Юридичний обов’язок</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Оцінка поста — це лише підказка. Вона визначає порядок у черзі, але сама не вирішує, що опублікувати. Якщо ви ввімкнули
        для каналу публікацію без рев’ю, пости виходять автоматично за вашим налаштуванням.
      </p>

      <h2>5. Як ми використовуємо AI</h2>
      <p>
        Ми передаємо постачальникам AI тексти постів, описи й зображення постів, транскрипти, вибірки зі статей, редакційний
        профіль, ваші попередні рішення, а також текст запиту до AI-асистента. Це потрібно для оцінки, перекладу, опису
        зображень, пошуку схожих постів і роботи асистента. Переписку з асистентом ми не зберігаємо: вона існує, доки відкритий
        редактор.
      </p>
      <p>
        Ваші рішення й історія каналу використовуються для підказок у вашому каналі. Ми не використовуємо їх для підказок іншим
        клієнтам.
      </p>

      <h2>6. Кому ми передаємо дані</h2>
      <p>
        Ми не продаємо персональні дані й не використовуємо їх для реклами. Дані отримують лише постачальники, без яких сервіс не
        працює:
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Постачальник</th>
              <th>Для чого</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Vercel</td>
              <td>Хостинг, журнали, зберігання завантажених файлів, анонімна статистика відвідувань публічних сторінок</td>
            </tr>
            <tr>
              <td>Neon</td>
              <td>База даних</td>
            </tr>
            <tr>
              <td>OpenAI</td>
              <td>Оцінка постів, переклад, embeddings, опис зображень, AI-асистент</td>
            </tr>
            <tr>
              <td>Anthropic</td>
              <td>Може використовуватися як альтернативний постачальник AI</td>
            </tr>
            <tr>
              <td>Telegram</td>
              <td>Вхід, робота бота, Mini App, публікація постів</td>
            </tr>
            <tr>
              <td>Supadata</td>
              <td>Транскрипти відео за посиланням на публічне відео</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Для читання джерел ми звертаємося до X API, YouTube Data API, RSS-стрічок і публічних сайтів. У цих запитах ми не
        передаємо ваші персональні дані: вони стосуються лише обраних джерел.
      </p>
      <p>
        Функції сервісу й база даних працюють у Франкфурті. Частина постачальників розташована поза ЄЕЗ, тому дані можуть
        передаватися за її межі. Ми можемо розкрити дані, якщо цього вимагає закон.
      </p>

      <h2>7. YouTube</h2>
      <p>
        Сервіс використовує YouTube API Services. Користуючись джерелами YouTube, ви погоджуєтеся з{' '}
        <a href={YOUTUBE_TERMS} rel="noopener">Умовами використання YouTube</a>. Дані обробляються також згідно з{' '}
        <a href={GOOGLE_PRIVACY} rel="noopener">Політикою конфіденційності Google</a>. Сервіс читає лише публічні дані каналів і
        відео та не отримує доступу до вашого акаунта Google.
      </p>

      <h2>8. Cookies</h2>
      <p>Ми використовуємо лише необхідні cookies:</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Cookie</th>
              <th>Для чого</th>
              <th>Строк</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>__Host-session</code>
              </td>
              <td>Тримає вас у системі на сайті рев’ю</td>
              <td>30 днів</td>
            </tr>
            <tr>
              <td>Cookie стану входу</td>
              <td>Захищає вхід через Telegram</td>
              <td>10 хвилин</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>На сайті немає рекламних чи аналітичних cookies. Відвідування публічних сторінок ми рахуємо через Vercel Web Analytics: цей сервіс не ставить cookies і дає нам лише узагальнену статистику.</p>

      <h2>9. Як довго ми зберігаємо дані</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Дані</th>
              <th>Строк</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Сесія</td>
              <td>До 30 днів або до виходу з акаунта</td>
            </tr>
            <tr>
              <td>Спроба входу</td>
              <td>До 10 хвилин</td>
            </tr>
            <tr>
              <td>Завантажені файли</td>
              <td>Видаляються зі сховища невдовзі після публікації або відхилення поста</td>
            </tr>
            <tr>
              <td>Переписка з AI-асистентом</td>
              <td>Не зберігається</td>
            </tr>
            <tr>
              <td>Акаунт, налаштування, пости, рішення, історія каналу</td>
              <td>Доки канал користується сервісом або доки ви не попросите видалити</td>
            </tr>
            <tr>
              <td>Технічні журнали</td>
              <td>Обмежений час, який встановлює наш хостинг</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Видалення джерела не прибирає пости, які воно вже принесло. Щоб видалити їх, напишіть нам. Те, що вже опубліковано у вашому
        Telegram-каналі, контролюєте ви і Telegram, а не ми.
      </p>

      <h2>10. Ваші права</h2>
      <p>
        Ви можете попросити доступ до своїх даних, їх виправлення, видалення, обмеження обробки, а також копію даних. Ви можете
        заперечити проти обробки на підставі законного інтересу. Напишіть <Contact />, і ми відповімо протягом 30 днів. Ви також
        можете подати скаргу до органу із захисту даних у вашій країні.
      </p>

      <h2>11. Безпека</h2>
      <p>
        З’єднання з сервісом зашифровані. Токени сесій зберігаються лише як хеші, а секрети прибираються з журналів. Жоден захист
        не є абсолютним; якщо станеться витік, який торкнеться вас, ми повідомимо згідно із законом.
      </p>

      <h2>12. Діти</h2>
      <p>Сервіс призначений для осіб від 16 років. Ми свідомо не збираємо дані дітей.</p>

      <h2>13. Зміни</h2>
      <p>
        Ми можемо оновлювати цю політику. Про суттєві зміни повідомимо на сайті або через бота й оновимо дату вгорі сторінки.
      </p>
    </>
  ),
};

export const privacy = { en, uk };

/** A link to this page, in the language of the page it is on. */
export function PrivacyLink({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <Link href={localePath(locale, '/privacy')}>{children}</Link>;
}
