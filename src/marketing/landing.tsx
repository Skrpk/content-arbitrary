import Link from 'next/link';
import { CONTACT_URL, SITE_NAME, SITE_URL } from '@/lib/site';
import { CONTENT, MOCKUP_FEED, MOCKUP_SOURCES } from './content';
import { LOCALES, localePath, type Locale } from './i18n';
import { USE_CASE_KEYS, USE_CASE_PAGES } from './pages/use-cases';

/**
 * The landing page, in one language. The words are in content.ts; this is
 * only their arrangement, shared by every language.
 */

/**
 * The buttons under a post in review once a channel has a Threads account, row
 * by row as the chat shows them (src/lib/sync/approval.ts). The lead one is
 * the one the page invites people to press.
 */
const MOCKUP_BUTTON_ROWS = [['✅ Telegram', '✅ Threads', '✅ Both'], ['🚫 Reject'], ['🕒 Schedule', '✏️ Edit text']];
const MOCKUP_LEAD_BUTTON = '✅ Both';

/**
 * A picture of what the product does: a morning's feed with the few posts
 * worth running under the marker, and the best of them as it reaches the
 * review queue — one card for three sources, ranked, rewritten in the
 * channel's language, with the review's real labels and buttons, Telegram,
 * Threads or both among them. People press those buttons, so each one opens
 * the same chat as the page's call to action.
 */
function ReviewMockup({ locale }: { locale: Locale }) {
  const text = CONTENT[locale].mockup;
  const [lead, ...others] = MOCKUP_SOURCES;

  return (
    <figure className="mockup" aria-label={text.label}>
      <div className="feed">
        <p className="feed__head">
          <span>{text.feedLabel}</span>
          <span>{text.scoreLabel}</span>
        </p>
        <ul lang="en">
          {MOCKUP_FEED.map((row) => (
            <li key={row.text} className={`feed__row feed__row--${row.kind}`}>
              <span className="feed__platform">{row.platform}</span>
              <span className="feed__text">
                {row.text}
                {row.kind === 'same' && <b> ↳ same story</b>}
              </span>
              <span className="feed__score">{row.score ?? '—'}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mockup__arrow">
        <span aria-hidden="true">↓ </span>
        {text.merged}
      </p>
      <div className="mockup__card">
        {/* The queue's own labels, which are English whatever the site's language. */}
        <div className="mockup__card-head" lang="en">
          <span className="mockup__score" title="Radar score">
            82
          </span>
          <strong>{lead.name}</strong>
          <span className="mockup__badge">📚 Same story · {others.length} more</span>
        </div>
        <p className="mockup__text" lang={text.textLang}>
          {text.text}
        </p>
        <p className="mockup__reason">
          <span lang="en">📡 likely approve — </span>
          {text.reason}
        </p>
        <p className="mockup__others" lang="en">
          {others.map((source) => source.name).join(' · ')} — ⇅ Use this one
        </p>
        <div className="mockup__buttons" lang="en">
          {MOCKUP_BUTTON_ROWS.map((row) => (
            <div key={row.join()} className="mockup__row">
              {row.map((button) => (
                <a
                  key={button}
                  className={button === MOCKUP_LEAD_BUTTON ? 'mockup__approve' : undefined}
                  href={CONTACT_URL}
                  rel="noopener"
                >
                  {button}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>
      <figcaption>{text.caption}</figcaption>
    </figure>
  );
}

/**
 * The picture above each of the four features that carry the product: the
 * score, one story from three sources, the rewrite, the voice. Decoration for
 * the words under it, which say the same thing.
 */
function FeatureVisual({ index, locale }: { index: number; locale: Locale }) {
  const text = CONTENT[locale];

  if (index === 0) {
    return (
      <p className="visual visual--score" aria-hidden="true" lang="en">
        <span>82</span> likely approve
      </p>
    );
  }
  if (index === 1) {
    return (
      <div className="visual visual--fold" aria-hidden="true">
        <ul lang="en">
          {MOCKUP_SOURCES.map((source) => (
            <li key={source.name}>
              {source.platform} · {source.name}
            </li>
          ))}
        </ul>
        <svg width="56" height="24" viewBox="0 0 56 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 12h48M42 4l8 8-8 8" />
        </svg>
        <span className="marked">{text.features.foldResult}</span>
      </div>
    );
  }
  if (index === 2) {
    return (
      <div className="visual visual--rewrite" aria-hidden="true">
        <s lang="en">{MOCKUP_SOURCES[0].text}</s>
        <p lang={text.mockup.textLang}>
          <span className="marked">{text.mockup.text}</span>
        </p>
      </div>
    );
  }
  return (
    <ul className="visual visual--voice" aria-hidden="true">
      {text.features.voiceTraits.map((trait) => (
        <li key={trait}>{trait}</li>
      ))}
      <li>{text.features.voiceSource}</li>
    </ul>
  );
}

/** How many features get a picture; the rest are the quiet row. */
const LEAD_FEATURES = 4;

export function Landing({ locale }: { locale: Locale }) {
  const text = CONTENT[locale];

  /** What search engines read: the site and who runs it — the name Google shows for it — the product, and the FAQ. */
  const organizationId = `${SITE_URL}/#organization`;
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      inLanguage: LOCALES,
      publisher: { '@id': organizationId },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': organizationId,
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/logo.png`,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      url: new URL(localePath(locale), SITE_URL).toString(),
      description: text.meta.description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, Telegram',
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
            <h1>
              {text.hero.title.before}
              <span className="marked">{text.hero.title.marked}</span>
              {text.hero.title.after}
            </h1>
            <p className="lead">{text.hero.lead}</p>
            <div className="hero__actions">
              <a className="button button--large" href={CONTACT_URL} rel="noopener">
                {text.hero.primary}
              </a>
              <a className="hero__more" href="#how-it-works">
                {text.hero.secondary}
              </a>
            </div>
            <p className="hero__note">{text.hero.note}</p>
          </div>
          <ReviewMockup locale={locale} />
        </div>
      </section>

      <div className="strip">
        <dl className="container strip__inner">
          <dt>{text.strip.reads}</dt>
          {text.strip.sources.map((source) => (
            <dd key={source}>{source}</dd>
          ))}
          <dt>{text.strip.publishes}</dt>
          {text.strip.targets.map((target) => (
            <dd key={target}>{target}</dd>
          ))}
        </dl>
      </div>

      <section id="features" className="section" aria-labelledby="features-title">
        <div className="container">
          <p className="eyebrow">{text.features.eyebrow}</p>
          <h2 id="features-title" className="section__title">
            {text.features.title}
          </h2>
          <ul className="desk">
            {text.features.items.slice(0, LEAD_FEATURES).map((feature, index) => (
              <li key={feature.title} className={index === 0 ? 'desk__cell desk__cell--inverse' : 'desk__cell'}>
                <FeatureVisual index={index} locale={locale} />
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </li>
            ))}
          </ul>
          <ul className="desk-more">
            {text.features.items.slice(LEAD_FEATURES).map((feature) => (
              <li key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section--tight" aria-label={`${text.compare.before.label} / ${text.compare.after.label}`}>
        <div className="container">
          <div className="compare">
            {(['before', 'after'] as const).map((side) => (
              <div key={side} className={`compare__side compare__side--${side}`}>
                <p className="eyebrow">{text.compare[side].label}</p>
                <p className="compare__title">{text.compare[side].title}</p>
                <ul>
                  {text.compare[side].items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="section section--inverse" aria-labelledby="how-title">
        <div className="container">
          <h2 id="how-title" className="section__title">
            {text.steps.title}
          </h2>
          <p className="section__lead">{text.steps.lead}</p>
          <ol className="steps">
            {text.steps.items.map((step, index) => (
              <li key={step.title} className="step">
                <span className="step__number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div aria-labelledby="audience-title" role="group">
            <h2 id="audience-title">{text.audiences.title}</h2>
            <ul className="ruled">
              {text.audiences.items.map((audience) => (
                <li key={audience.title}>
                  <h3>{audience.title}</h3>
                  <p>{audience.text}</p>
                </li>
              ))}
            </ul>
          </div>
          <div aria-labelledby="use-cases-title" role="group">
            <h2 id="use-cases-title">{text.useCases.title}</h2>
            <ul className="ruled ruled--links">
              {USE_CASE_KEYS.map((key) => (
                <li key={key}>
                  <h3>
                    <Link href={localePath(locale, `/${key}`)}>{USE_CASE_PAGES[key][locale].title}</Link>
                  </h3>
                  <p>{USE_CASE_PAGES[key][locale].description}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="faq" className="section section--tight" aria-labelledby="faq-title">
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

      <section className="section section--tight" aria-labelledby="cta-title">
        <div className="container">
          <div className="cta">
            <div>
              <h2 id="cta-title">{text.cta.title}</h2>
              <p>{text.cta.text}</p>
            </div>
            <a className="button button--large button--ink" href={CONTACT_URL} rel="noopener">
              {text.cta.button}
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
