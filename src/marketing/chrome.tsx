import Link from 'next/link';
import { CONTACT_URL, SITE_NAME } from '@/lib/site';
import { CONTENT } from './content';
import { LOCALES, localePath, type Locale } from './i18n';

/**
 * The header and footer every public page shares. Plain server components:
 * the site ships no JavaScript of its own.
 */

export function SiteHeader({ locale, path = '' }: { locale: Locale; path?: string }) {
  const text = CONTENT[locale];
  const home = localePath(locale);

  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <Link href={home} className="brand" aria-label={`${SITE_NAME} — ${text.nav.home}`}>
          <span className="brand__mark" aria-hidden="true">
            X→✈
          </span>
          <span>{SITE_NAME}</span>
        </Link>
        <nav aria-label={text.nav.main} className="site-nav">
          <Link href={`${home}#features`}>{text.nav.features}</Link>
          <Link href={`${home}#how-it-works`}>{text.nav.howItWorks}</Link>
          <Link href={`${home}#faq`}>{text.nav.faq}</Link>
        </nav>
        <nav aria-label={text.languageSwitch.label} className="language-switch">
          {LOCALES.map((other) =>
            other === locale ? (
              <span key={other} aria-current="true">
                {text.languageSwitch.names[other]}
              </span>
            ) : (
              <Link key={other} href={localePath(other, path)} hrefLang={other} lang={other}>
                {text.languageSwitch.names[other]}
              </Link>
            ),
          )}
        </nav>
        <a className="button button--small" href={CONTACT_URL} rel="noopener">
          {text.connect}
        </a>
      </div>
    </header>
  );
}

export function SiteFooter({ locale }: { locale: Locale }) {
  const text = CONTENT[locale].footer;

  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p>
          © {new Date().getFullYear()} {SITE_NAME}. {text.disclaimer}
        </p>
        <a href={CONTACT_URL} rel="noopener">
          {text.contact}
        </a>
      </div>
    </footer>
  );
}
