/**
 * A channel's `workspaces.language` (BCP 47) as people set it: in the bot's
 * 🌐 Мова and in Settings. Free of server-only imports, since the settings
 * page uses it too.
 */

/** What the column's check accepts. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * A typed code in its canonical form (`PT_br` → `pt-BR`), or null for one
 * that is not a language anyone knows — `xx` is well-formed and still refused.
 */
export function normaliseLanguageCode(text: string): string | null {
  const typed = text.trim().replace(/_/g, '-');
  if (typed === '' || typed.length > 35) return null;
  let code: string;
  try {
    code = Intl.getCanonicalLocales(typed)[0] ?? '';
  } catch {
    return null;
  }
  if (!LANGUAGE_PATTERN.test(code)) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code) ? code : null;
  } catch {
    return null;
  }
}

/** The language's name in `displayIn` — `uk` in Ukrainian is «українська» — or the code itself. */
export function languageLabel(code: string, displayIn: string): string {
  try {
    return new Intl.DisplayNames([displayIn], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
