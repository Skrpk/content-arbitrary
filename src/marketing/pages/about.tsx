import { PrivacyLink } from './privacy';
import { Contact, type PublicPage } from './shared';

/** What Zmistik is. As on the landing, only what the product does today. */

const en: PublicPage = {
  title: 'About Zmistik',
  description: 'Zmistik is an AI editorial desk for your channels: it follows sources and prepares posts, and you decide.',
  body: (
    <>
      <p>
        Zmistik is an AI editorial desk for your channels, on Telegram and Threads. It takes on the routine: following sources, picking out what matters
        and preparing draft posts. The decision on what to publish stays with the editor.
      </p>

      <h2>The problem we solve</h2>
      <p>
        A channel’s administrator goes through dozens of sources every day: X accounts, websites, other channels, YouTube. Most of
        that stream does not suit the channel, one piece of news repeats several times, and what does suit it still has to be
        translated and rewritten. Little time is left for the editing itself.
      </p>

      <h2>How Zmistik works</h2>
      <ul>
        <li>
          <strong>It follows sources.</strong> X and Threads accounts, RSS feeds, public Telegram and YouTube channels, and websites
          through their sitemaps.
        </li>
        <li>
          <strong>It scores every post.</strong> The queue is sorted by what your channel is most likely to publish, and each score
          comes with a short reason.
        </li>
        <li>
          <strong>It gathers one story into one card.</strong> The same event from several sources does not clog the queue.
        </li>
        <li>
          <strong>It prepares the text.</strong> A post is rewritten in your channel’s language and voice, and in the editor an AI
          assistant helps.
        </li>
        <li>
          <strong>It waits for your decision.</strong> Approve, edit, schedule or reject, in Telegram or in the browser, and publish
          to your Telegram channel, your Threads account or both.
        </li>
      </ul>

      <h2>What matters to us</h2>
      <ul>
        <li>
          <strong>The editor is in charge.</strong> A score only orders the queue. Publishing without review is on only if you choose it.
        </li>
        <li>
          <strong>The service learns from your decisions.</strong> Your description of the channel, the posts you approve and reject
          and your past publications help it sort the queue more accurately.
        </li>
        <li>
          <strong>Openness.</strong> Next to a score you see its reason, and next to a post its source. How we handle data is set
          out in the <PrivacyLink locale="en">Privacy Policy</PrivacyLink>.
        </li>
      </ul>

      <h2>Who it is for</h2>
      <p>
        For administrators and editors of Telegram channels and Threads accounts who regularly publish material based on other
        sources: news, science, technology, niche topics.
      </p>

      <h2>Contact</h2>
      <p>
        Message us on Telegram: <Contact />.
      </p>
    </>
  ),
};

const uk: PublicPage = {
  title: 'Про Zmistik',
  description: 'Zmistik — AI-редакція для ваших каналів: стежить за джерелами й готує пости, а рішення лишається за вами.',
  body: (
    <>
      <p>
        Zmistik — це AI-редакція для ваших каналів у Telegram і Threads. Вона бере на себе рутину: стежить за джерелами, відбирає важливе й готує
        чернетки постів. Рішення, що публікувати, лишається за редактором.
      </p>

      <h2>Яку проблему ми вирішуємо</h2>
      <p>
        Адміністратор каналу щодня переглядає десятки джерел: акаунти в X, сайти, інші канали, YouTube. Більша частина цього потоку
        каналу не підходить, одна новина повторюється по кілька разів, а потрібне ще треба перекласти й переписати. На саму редактуру
        лишається мало часу.
      </p>

      <h2>Як працює Zmistik</h2>
      <ul>
        <li>
          <strong>Стежить за джерелами.</strong> Акаунти X і Threads, RSS-стрічки, публічні канали Telegram і YouTube, сайти через
          їхні sitemap.
        </li>
        <li>
          <strong>Оцінює кожен пост.</strong> Черга шикується за тим, що ймовірніше опублікує саме ваш канал, і кожна оцінка має коротке
          пояснення.
        </li>
        <li>
          <strong>Збирає одну новину в одну картку.</strong> Та сама подія з різних джерел не забиває чергу.
        </li>
        <li>
          <strong>Готує текст.</strong> Пост переписується мовою й голосом каналу, а в редакторі допомагає AI-асистент.
        </li>
        <li>
          <strong>Чекає вашого рішення.</strong> Погодити, відредагувати, запланувати чи відхилити можна в Telegram або в браузері, а
          опублікувати — у Telegram-канал, акаунт Threads або в обидва.
        </li>
      </ul>

      <h2>Що для нас важливо</h2>
      <ul>
        <li>
          <strong>Редактор головний.</strong> Оцінка лише впорядковує чергу. Публікація без рев’ю вмикається лише за вашим вибором.
        </li>
        <li>
          <strong>Сервіс вчиться на ваших рішеннях.</strong> Ваш опис каналу, схвалені й відхилені пости та минулі публікації допомагають
          точніше сортувати чергу.
        </li>
        <li>
          <strong>Прозорість.</strong> Біля оцінки видно причину, а біля поста — джерело. Як ми працюємо з даними, описано в{' '}
          <PrivacyLink locale="uk">Політиці конфіденційності</PrivacyLink>.
        </li>
      </ul>

      <h2>Для кого</h2>
      <p>
        Для адміністраторів і редакторів Telegram-каналів та акаунтів у Threads, які регулярно публікують матеріали на основі чужих
        джерел: новини, наука, технології, нішеві теми.
      </p>

      <h2>Контакти</h2>
      <p>
        Напишіть у Telegram: <Contact />.
      </p>
    </>
  ),
};

export const about = { en, uk };
