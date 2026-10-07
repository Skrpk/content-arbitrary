import { CONTACT_URL, SITE_NAME, SITE_URL } from '@/lib/site';
import { CONTENT } from './content';
import { localePath, type Locale } from './i18n';

/**
 * The landing page, in one language. The words are in content.ts; this is
 * only their arrangement, shared by every language.
 */

/**
 * A static picture of what the bot does with a post: the source's original on
 * X, and the review message it becomes — rewritten in the channel's language,
 * with the bot's real buttons.
 */
function ReviewMockup({ locale }: { locale: Locale }) {
  const text = CONTENT[locale].mockup;

  return (
    <figure className="mockup" aria-label={text.label}>
      <div className="mockup__original">
        <p className="mockup__original-label">{text.originalLabel}</p>
        <p lang="en">{text.original}</p>
      </div>
      <p className="mockup__arrow">
        <span aria-hidden="true">↓ </span>
        {text.rewritten}
      </p>
      <div className="mockup__chat">
        <div className="mockup__bubble">
          <div className="mockup__media" aria-hidden="true">
            <span>📷</span>
          </div>
          <p className="mockup__text" lang={text.textLang}>
            {text.text}
          </p>
          <p className="mockup__source">Source: x.com/…/status/1750…</p>
        </div>
        <div className="mockup__bubble mockup__bubble--control">
          <p className="mockup__source">Source: @source_account</p>
        </div>
        {/* The bot's own labels, which are English whatever the site's language. */}
        <div className="mockup__buttons" lang="en">
          <span>✅ Approve</span>
          <span>🚫 Reject</span>
          <span>🕒 Schedule</span>
          <span>✏️ Edit text</span>
        </div>
      </div>
      <figcaption>{text.caption}</figcaption>
    </figure>
  );
}

export function Landing({ locale }: { locale: Locale }) {
  const text = CONTENT[locale];

  /** What search engines read: the product, and the FAQ as rich results. */
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      url: new URL(localePath(locale), SITE_URL).toString(),
      description: text.meta.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Telegram',
      inLanguage: locale,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      inLanguage: locale,
      mainEntity: text.faq.items.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer },
      })),
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        // Static, built from content.ts; nothing user-supplied.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <section className="hero">
        <div className="container hero__inner">
          <div className="hero__copy">
            <p className="eyebrow">{text.hero.eyebrow}</p>
            <h1>{text.hero.title}</h1>
            <p className="lead">{text.hero.lead}</p>
            <div className="hero__actions">
              <a className="button" href={CONTACT_URL} rel="noopener">
                {text.hero.primary}
              </a>
              <a className="button button--ghost" href="#how-it-works">
                {text.hero.secondary}
              </a>
            </div>
          </div>
          <ReviewMockup locale={locale} />
        </div>
      </section>

      <section id="features" className="section" aria-labelledby="features-title">
        <div className="container">
          <h2 id="features-title">{text.features.title}</h2>
          <p className="section__lead">{text.features.lead}</p>
          <ul className="grid grid--features">
            {text.features.items.map((feature) => (
              <li key={feature.title} className="card">
                <span className="card__icon" aria-hidden="true">
                  {feature.icon}
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="how-it-works" className="section section--alt" aria-labelledby="how-title">
        <div className="container">
          <h2 id="how-title">{text.steps.title}</h2>
          <p className="section__lead">{text.steps.lead}</p>
          <ol className="grid grid--steps">
            {text.steps.items.map((step, index) => (
              <li key={step.title} className="step">
                <span className="step__number" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" aria-labelledby="audience-title">
        <div className="container">
          <h2 id="audience-title">{text.audiences.title}</h2>
          <ul className="grid grid--audience">
            {text.audiences.items.map((audience) => (
              <li key={audience.title} className="card">
                <h3>{audience.title}</h3>
                <p>{audience.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="faq" className="section section--alt" aria-labelledby="faq-title">
        <div className="container container--narrow">
          <h2 id="faq-title">{text.faq.title}</h2>
          <div className="faq">
            {text.faq.items.map((item) => (
              <details key={item.question} className="faq__item">
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section cta" aria-labelledby="cta-title">
        <div className="container container--narrow cta__inner">
          <h2 id="cta-title">{text.cta.title}</h2>
          <p>{text.cta.text}</p>
          <a className="button" href={CONTACT_URL} rel="noopener">
            {text.cta.button}
          </a>
        </div>
      </section>
    </>
  );
}
