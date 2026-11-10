import { PrivacyLink } from './privacy';
import { Contact, type PublicPage } from './shared';

/**
 * The terms of service. What the service does is stated as it stands: no
 * prices, no governing law named until there is an entity to name one for.
 */

const en: PublicPage = {
  title: 'Terms of Service',
  description: 'The rules for using Zmistik: your account, your responsibility for what you publish, AI results and limits.',
  effective: 'In effect from 9 November 2026.',
  body: (
    <>
      <p>
        These terms govern the use of Zmistik: its website, Telegram bot and Mini App. The service is provided by Zmistik
        (“we”). By using it you agree to these terms.
      </p>

      <h2>1. What the service does</h2>
      <p>
        Zmistik reads the public sources you choose, scores new material for your channel, groups reports of one event, prepares
        text in your channel’s language and publishes what you approve — to your Telegram channel, and, if you connect one, to
        your Threads account, wherever you choose for each post. If you set it so, a channel can publish without review.
      </p>

      <h2>2. Account and access</h2>
      <p>
        To use the service you need a Telegram account, to be at least 16 years old, and the right to manage the channel you
        connect the bot to. The bot works in the channel as an administrator. You are responsible for the security of your
        account and for what is done through it.
      </p>

      <h2>3. Payment</h2>
      <p>
        The service has no published prices for now, and we take no payments through the site. If we introduce a charge, we will
        tell you the price and terms in advance. You will pay nothing without your agreement.
      </p>

      <h2>4. Your responsibility for content</h2>
      <p>
        You decide what your channel publishes and you are responsible for it. This includes posts that go out automatically
        under your settings. In particular, you confirm that you:
      </p>
      <ul>
        <li>
          have the right to use and publish material from your chosen sources in the form you publish it, including photos,
          videos, translations and rewritten texts;
        </li>
        <li>respect copyright, credit sources where required and do not infringe other people’s rights;</li>
        <li>follow the rules of Telegram, of Threads if you publish there, and of the platforms you chose as sources.</li>
      </ul>
      <p>We do not check, and do not grant you, rights to other people’s content.</p>

      <h2>5. AI results</h2>
      <p>
        Scores, translations, rewritten texts and the assistant’s suggestions are generated automatically and may contain errors,
        inaccuracies or invented facts. Check important facts, figures and names before publishing. A score only helps order the
        queue and does not guarantee a post suits your channel.
      </p>

      <h2>6. Your materials</h2>
      <p>
        You remain the owner of what you add to the service: your editorial profile, texts, files and channel history. You allow
        us to store and process these materials, including through the providers listed in the{' '}
        <PrivacyLink locale="en">Privacy Policy</PrivacyLink>, only as far as needed to run the service for you.
      </p>

      <h2>7. Prohibited use</h2>
      <p>Do not use the service to:</p>
      <ul>
        <li>spread illegal content, disinformation, spam, hate speech or material that infringes others’ rights;</li>
        <li>bypass paywalls, restrictions or protections of third-party sites;</li>
        <li>interfere with the service, try to reach other people’s data or overload it;</li>
        <li>resell the service without our written consent.</li>
      </ul>

      <h2>8. Third-party services</h2>
      <p>
        Zmistik depends on Telegram, Threads, X, YouTube, AI services and the sites it reads. They may change their rules, limit access or
        stop working, and some features may then not work. Sites that block automated access or show articles only through
        JavaScript may not be readable. These services are not affiliated with us. X is a trademark of X Corp., Telegram of
        Telegram FZ-LLC, YouTube of Google LLC and Threads of Meta Platforms, Inc.
      </p>

      <h2>9. Availability and changes</h2>
      <p>
        The service is provided “as is” and changes all the time. We do not guarantee uninterrupted or error-free work, or
        publication at an exact time. We may add, change or remove features.
      </p>

      <h2>10. Ending use</h2>
      <p>
        You may stop at any time: remove the bot from your channel and write to <Contact /> if you want your data deleted. We may
        limit or end access if you break these terms, if the law requires it or if we close the service. If we close the service,
        we will warn you in advance where possible.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect damages, lost profits, loss of audience or a blocked channel,
        or for content published in your channel. This section does not limit rights that the law does not allow to be limited.
      </p>

      <h2>12. Complaints about content</h2>
      <p>
        If you believe a channel infringes your rights, contact its administrator or Telegram. You can also write to <Contact /> and
        we will look into it.
      </p>

      <h2>13. Changes to these terms</h2>
      <p>
        We will announce material changes on the site or through the bot at least 14 days in advance. If you do not agree with
        them, stop using the service.
      </p>

      <h2>14. Disputes</h2>
      <p>
        First write to <Contact /> and we will try to resolve the matter without a court. Otherwise a dispute is settled under the
        applicable law.
      </p>
    </>
  ),
};

const uk: PublicPage = {
  title: 'Умови використання',
  description: 'Правила користування Zmistik: акаунт, ваша відповідальність за публікації, результати AI та обмеження.',
  effective: 'Чинні з 9 листопада 2026 року.',
  body: (
    <>
      <p>
        Ці умови регулюють використання Zmistik — сайту, Telegram-бота й Mini App. Сервіс надає Zmistik (далі «ми»). Користуючись
        сервісом, ви погоджуєтеся з цими умовами.
      </p>

      <h2>1. Що робить сервіс</h2>
      <p>
        Zmistik читає обрані вами публічні джерела, оцінює нові матеріали для вашого каналу, групує повідомлення про одну подію,
        готує текст мовою каналу й публікує те, що ви схвалили: у ваш Telegram-канал, а якщо ви підключили акаунт Threads, то й
        туди, куди ви оберете для кожного поста. За вашим налаштуванням канал може публікувати пости без рев’ю.
      </p>

      <h2>2. Акаунт і доступ</h2>
      <p>
        Щоб користуватися сервісом, потрібні акаунт Telegram, вік від 16 років і право керувати каналом, до якого ви підключаєте
        бота. Бот працює в каналі як адміністратор. Ви відповідаєте за безпеку свого акаунта й за дії, зроблені через нього.
      </p>

      <h2>3. Оплата</h2>
      <p>
        Зараз сервіс не має опублікованих тарифів, і ми не беремо оплату через сайт. Якщо ми запровадимо плату, то заздалегідь
        повідомимо ціну й умови. Без вашої згоди ви не сплатите нічого.
      </p>

      <h2>4. Ваша відповідальність за контент</h2>
      <p>
        Ви вирішуєте, що публікує ваш канал, і відповідаєте за це. Це стосується і постів, що виходять автоматично за вашим
        налаштуванням. Зокрема, ви гарантуєте, що:
      </p>
      <ul>
        <li>
          маєте право використовувати й публікувати матеріали з обраних джерел у тій формі, в якій їх публікуєте, уключно з фото,
          відео, перекладами й переписаними текстами;
        </li>
        <li>дотримуєтеся авторського права, вказуєте джерела там, де це потрібно, і не порушуєте права інших людей;</li>
        <li>дотримуєтеся правил Telegram, Threads (якщо публікуєте туди) та платформ, які обрали як джерела.</li>
      </ul>
      <p>Ми не перевіряємо і не надаємо вам прав на чужий контент.</p>

      <h2>5. Результати AI</h2>
      <p>
        Оцінки, переклади, переписані тексти й підказки асистента створюються автоматично і можуть містити помилки, неточності чи
        вигадані факти. Перевіряйте важливі факти, цифри й імена перед публікацією. Оцінка лише допомагає впорядкувати чергу і не
        гарантує, що пост підійде каналу.
      </p>

      <h2>6. Ваші матеріали</h2>
      <p>
        Ви лишаєтеся власником того, що додаєте в сервіс: редакційного профілю, текстів, файлів і історії каналу. Ви дозволяєте нам
        зберігати й обробляти ці матеріали, у тому числі через постачальників із <PrivacyLink locale="uk">Політики конфіденційності</PrivacyLink>,
        лише в обсязі, потрібному для роботи сервісу для вас.
      </p>

      <h2>7. Заборонене використання</h2>
      <p>Не використовуйте сервіс, щоб:</p>
      <ul>
        <li>поширювати незаконний контент, дезінформацію, спам, мову ворожнечі чи матеріали, що порушують чужі права;</li>
        <li>обходити платний доступ, обмеження чи захист сторонніх сайтів;</li>
        <li>втручатися в роботу сервісу, пробувати отримати доступ до чужих даних або надмірно його навантажувати;</li>
        <li>перепродавати сервіс без нашої письмової згоди.</li>
      </ul>

      <h2>8. Сторонні сервіси</h2>
      <p>
        Робота Zmistik залежить від Telegram, Threads, X, YouTube, AI-сервісів та сайтів-джерел. Вони можуть змінити правила, обмежити доступ
        або припинити роботу, і тоді частина функцій може не працювати. Сайти, які блокують автоматичний доступ або показують статті
        лише через JavaScript, можуть не читатися. Ці сервіси не пов’язані з нами. X — торгова марка X Corp., Telegram — Telegram
        FZ-LLC, YouTube — Google LLC, Threads — Meta Platforms, Inc.
      </p>

      <h2>9. Доступність і зміни</h2>
      <p>
        Сервіс надається «як є» і постійно змінюється. Ми не гарантуємо безперервної роботи, безпомилковості чи публікації в точний
        час. Ми можемо додавати, змінювати або прибирати функції.
      </p>

      <h2>10. Припинення</h2>
      <p>
        Ви можете припинити користування будь-коли: прибрати бота з каналу й написати <Contact />, якщо хочете видалити дані. Ми
        можемо обмежити або припинити доступ, якщо ви порушуєте ці умови, цього вимагає закон або ми закриваємо сервіс. У разі
        закриття сервісу ми попередимо заздалегідь, якщо це можливо.
      </p>

      <h2>11. Обмеження відповідальності</h2>
      <p>
        У межах, дозволених законом, ми не відповідаємо за непрямі збитки, втрачену вигоду, втрату аудиторії чи блокування каналу, а
        також за контент, опублікований у вашому каналі. Цей розділ не обмежує права, яких закон не дозволяє обмежувати.
      </p>

      <h2>12. Скарги на контент</h2>
      <p>
        Якщо вважаєте, що канал порушує ваші права, звертайтеся до його адміністратора або в Telegram. Також можете написати <Contact />,
        і ми розглянемо запит.
      </p>

      <h2>13. Зміни цих умов</h2>
      <p>
        Про суттєві зміни ми повідомимо на сайті або через бота щонайменше за 14 днів. Якщо ви з ними не згодні, припиніть
        користування сервісом.
      </p>

      <h2>14. Спори</h2>
      <p>
        Спочатку напишіть <Contact />, і ми спробуємо вирішити питання без суду. Інакше спір вирішується відповідно до застосовного
        права.
      </p>
    </>
  ),
};

export const terms = { en, uk };
