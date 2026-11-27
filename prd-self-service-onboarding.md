# PRD — Self-Service Telegram Onboarding & Source Discovery v1

Product: Zmistik
Feature: Telegram bot onboarding → channel analysis → editorial profile → automatic sources → a daily digest in the bot
Version: v1, revision 7 (checked against the repository on 2026-11-27)
Primary interface: `@ZmistikBot` private chat

## How this fits with what exists (read this first)

There is no second system. Onboarding is only a new way to **create** a
workspace: by the user, in the bot, instead of by an operator. From then on
every workspace, old or new, runs the same pipeline and the same review:

```
sources → Radar scores → stories → review queue (website / Mini App)
                                  ↳ the daily digest in the bot (exists)
```

A new workspace is an ordinary workspace with these settings:

- **Notifications:** the digest that exists today, **once a day** at 09:00
  (`review_digest_minutes = 1440`, `review_digest_hour = 9`). It lists Radar's
  best stories, each a button to its card in the queue. No per-post messages
  and nothing new to build for delivery (§24).
- **Publishing:** the same Approve dialog as everyone has. Until the channel
  posts go to is connected (`channel_verified_at`, §25), **Publish now** and
  **Schedule** open a popup, *"Set up the channel your posts go to"*, with a
  button to Settings. There the user adds the bot as an admin and presses
  Check. **Send to preview** works without a channel: the post comes to the
  user's own bot chat, to forward or copy by hand.

| Workspace | Notifications | Channel connected | What they see |
|-----------|---------------|-------------------|---------------|
| Existing ones (vector, …) | as set today | yes (migration) | **nothing changes** |
| New, right after onboarding | daily digest at 09:00 | no | the digest; in the queue Approve → popup → Settings; Send to preview works |
| The same, after connecting the channel | unchanged | yes | exactly what operator workspaces have |

The only new thing on the website and Mini App is that popup, the "Publishing
channel" block in Settings (§25a), and the language field (§33). No second set
of buttons, no new post status.

**Already shipped on `main`, and live since 2026-11-26:**
- Send to preview sends the post to the pressing reviewer's own chat with the
  bot. The preview channel setting and its column (`workspaces.draft_chat_id`,
  migration 0047) are gone.
- The legacy draft channel is gone: its code, its cron step, its buttons, and
  the `channel_drafts` table (migration 0048). Approve publishes or schedules
  straight from Zmistik. Scheduled posts wait in Zmistik and the cron publishes
  them into the channel.

**New in this PRD:** onboarding in the bot (§5–§23), `/profile` in the bot
(§14a), the publish gate with its popup (§25), connecting the channel from
Settings (§25a), and a language field in Settings (§33).

<details><summary>Revision history</summary>

- **7:** delivery is the existing digest, once a day; the "only the best, as
  they come" pushes, 👍/👎/✍️ and the `liked` status are dropped. Publishing
  without a connected channel opens a popup that leads to Settings, and
  connecting the channel (was v2) is now part of v1 (§25a).
- **6:** the overview above. Preview to the bot chat (D11) and the draft
  channel's removal are now shipped, so the gate list in §25 no longer names
  draft code.
- **5:** no `delivery_mode` switch; notifications and publishing became two
  independent settings; preview goes to the bot chat.
- **4:** editing the editorial profile in the bot (§14a); learning from the
  latest 100 posts only (§9); the website and Mini App for a workspace that
  cannot publish (§33).
- **3:** instead of "select sources, then get a digest": channel → analysis →
  editorial profile → 5 sources connected automatically (no X) → the best
  posts arrive in the bot one by one, with 👍 / 👎 / «Зробити пост».
- **2:** checked against the code; added the publish gate, the step runner,
  the history key, message routing, forwards as a signal, RSS before
  sitemaps, YouTube video links, and limits.

</details>

---

## 0. Decisions

| # | Decision | Resolution |
|---|----------|------------|
| D1 | What the user gets | Fully automatic: the user sends a channel, the bot reads its latest posts, writes the editorial profile, connects 5 sources (no X) and from then on sends **the existing daily digest**. Nothing to configure |
| D1a | Notification | The existing digest (`src/lib/review/digest.ts`, `sendReviewDigest`), once a day at 09:00 in the workspace's time zone (`review_digest_minutes = 1440`, `review_digest_hour = 9`). It can be changed in Settings like any workspace's. No per-post pushes, no new delivery code |
| D1b | Buttons and publishing | The same review as operator workspaces: Approve / Reject / Edit, the Approve dialog. **Publishing needs a connected channel** (`channel_verified_at`). Without it, Publish now and Schedule open the "Set up the channel your posts go to" popup with a link to Settings; the server refuses too (§25). Send to preview always works |
| D1c | Sources | Exactly 5 picked automatically and connected at once (fewer if fewer pass validation). Then a "Стежу за: …" message where each source has ✕ to remove it; after a removal the bot offers the next-best candidate with ➕ |
| D2 | Where the long steps run | A step runner over `onboarding_sessions`. The webhook kicks it with `after()`, `/api/onboarding/run` runs one step per call (`maxDuration` 800), and the every-minute cron sweeps up stalled or retrying sessions. No external queue |
| D3 | Language | Set `workspaces.language` automatically (BCP 47) from the history |
| D4 | X | Never suggested in v1. Threads isn't either |
| D5 | Alpha gate | Global cap of 50 self-service workspaces, at most 30 onboarding runs a day, an optional allowlist; past a cap, a waitlist message |
| D6 | Discovery model | OpenAI Responses with `web_search`, as `src/lib/assistant/openai.ts` |
| D7 | Analytics | New `product_events` table |
| D8 | Editing the editorial profile | Also **in the bot chat**: `/profile` shows it, with buttons to replace it with their own text or to refine it with an instruction (the LLM rewrites, the user confirms). See §14a. Settings (website / Mini App) keeps its editor |
| D9 | How much history is learned from | **Only the latest 100 usable posts** (scan at most 200 messages) |
| D10 | Website and Mini App | The same pages for every workspace. The only differences for one without a connected channel: the popup (§25), the "Publishing channel" block in Settings (§25a), auto-publish off until connected. See §33 |
| D11 | Preview | No preview channel anywhere. Send to preview sends the post, exactly as it would go out, to the pressing reviewer's own chat with the bot. **Shipped** (commit e1247a3, migration 0047, live since 2026-11-26) |
| D12 | Connecting the channel | **In v1**, from Settings: add the bot as an admin that can post, press Check. The bot must be able to post and the user must be the channel's creator or an admin who can post. The channel is the one onboarded (`telegram_chat_id`) |

**Spike before §6: done (2026-11-27).** Bot API `getChat("@durov")` returned `-1001006503122`, type `channel` and the title, with the bot not in the channel. So §6 validates with `getChat` and history is keyed by `-100<id>`. `tg:<username>` stays only as the fallback when `getChat` fails.

---

## 1. Problem

Zmistik already has the intelligence layer: multi-tenant workspaces; Telegram/X/RSS/YouTube/website/Threads sources; publication history with profiles and embeddings; Shadow Radar; story clustering; the review queue.

But an operator still creates every workspace and configures every source by hand. The first experience should instead be:

```
/start → send your channel → Zmistik reads its public history → understands it
→ connects 5 sources on its own → every morning, a digest of what is worth your time
```

The user never meets tenants, embeddings, Radar, RSS or sitemaps.

## 2. Goal

From opening `@ZmistikBot` to the first digest of relevant stories, without leaving Telegram and without configuring anything.

- Under 3 minutes from submitting the channel to "Стежу за 5 джерелами" (tight, see §8).
- The first digest arrives the next morning at 09:00 (§24).

## 3. Non-goals for v1

Per-post push notifications; a source-selection step; publishing to a channel other than the onboarded one; billing; referrals; Instagram/TikTok; private channels; competitor analysis; crawling the web; X or Threads in discovery; changing sources automatically after onboarding.

## 4. Existing systems to reuse (verified)

| Area | Where | Note |
|------|-------|------|
| Workspace = tenant | `src/db/schema.ts` `workspaces` | |
| Users, identities, members (`owner`/`reviewer`) | `users`, `user_identities`, `workspace_members`; `src/lib/accounts/users.ts` | |
| Public channel reader, `?before=` paging | `src/lib/telegram-channel/client.ts` | about 20 posts per page |
| Username normalisation | `src/lib/telegram-channel/username.ts` | post links resolve to the channel; invite links rejected |
| Page parser | `src/lib/telegram-channel/parser.ts` | drops `href`s and forward origin today (§12) |
| History model / import | `src/lib/history/types.ts`, `import-history.ts` | file-oriented; extract persistence (§10) |
| History profile, embeddings | `src/lib/history/profile/build.ts`, `src/lib/history/embeddings/*` | CLI-only today; 24k chars per batch, up to 180 s per call |
| Add-source functions | `src/lib/sources/add-*.ts` | validate, then `addSource`; split them (§18) |
| `addSource` upsert | `src/lib/sources/repository.ts` | no `includeTextOnly` / `radarThreshold` option yet (§22) |
| "From now" semantics | `sources.following_since` | unchanged |
| Radar | `src/lib/radar/shadow.ts` `runLiveRadar`, run inline in `src/lib/sync/process-candidate.ts` **before review**, along with story placement | the digest reads these scores |
| Daily digest | `src/lib/review/digest.ts`, `sendReviewDigest` in `src/lib/review/queue.ts`; `review_digest_minutes / _hour / _timezone` | reused as is (§24) |
| Radar needs a profile | `workspaces.editorial_profile`; null = Radar off | hence §14 |
| Approve dialog, Send to preview | `ApproveDialog` in `src/components/review-queue.tsx`, `.../webapp/preview`, `previewPost` in `src/lib/sync/publish.ts` | gets the popup (§25); preview already goes to the reviewer's bot chat (D11, shipped) |
| Chat checks | `TelegramClient.getChat / getChatMember / getMe` | for §6 and connecting the channel (§25a) |
| Fetch safety | `isPrivateAddress` (`src/lib/rss/url.ts`), `src/lib/website/http.ts` | every discovery fetch goes through them |

Principle: **onboarding discovers and orchestrates; existing systems stay authoritative.** No second monitor, scorer or source store.

---

## 5. Flow

### Step 1: `/start`

For a user with no workspace and no active session:

> 👋 Привіт! Я Змістик.
> Надішли мені публічний Telegram-канал, для якого ти робиш контент. Я проаналізую, що він публікує, сам знайду джерела й надсилатиму тобі новини, які варто взяти в роботу.
> Формат: `@channelname` або `https://t.me/channelname`

**Alpha gate (built in step 3):** onboarding answers only Telegram user ids listed in `ONBOARDING_ALLOWLIST` (comma-separated). Unset, nobody gets it, and strangers see `strangerGreeting` as before. Step 7 adds the caps and the waitlist.

Accepted: `@channel`, `t.me/channel`, `https://t.me/channel`, `https://t.me/channel/123`, `https://t.me/s/channel`. Copy is in Ukrainian when `language_code` starts with `uk`, otherwise English. This replaces `strangerGreeting` in private chats.

### 5a. Message routing (new)

`handleCommandMessage` (`src/app/api/telegram/webhook/route.ts`) currently ignores non-command text. Commands and callbacks are handled only for existing reviewers, and `/start` from a reviewer returns help. Onboarding gets its own routing, **checked before the reviewer lookup**:

1. Private chats only (`chat.type === 'private'`).
2. `/start`:
   - with an active session, repeat its current prompt or status;
   - with no workspace, start onboarding;
   - with a workspace, show help (plus a line about `/newchannel`).
3. `/newchannel`: onboard another channel, within the per-user limit (§28).
4. Plain text while the session is `awaiting_channel`: treat it as the channel. Otherwise, plain text with a live `bot_pending_inputs` row is that input (§14a).
5. `/profile`: the profile screen (§14a).
6. `ob:` callbacks (onboarding) and `pf:` callbacks (profile screen) are handled before the reviewer check. They are authorised by the session's or workspace's owner Telegram id.

### Step 2: validation (§6)

> ✅ Знайшов **NAUKA.UA**. Аналізую останні пости — зазвичай це пару хвилин.

### Step 3: analysis progress (one message, edited in place)

> ✅ Проаналізував останні 100 постів. Канал переважно про: • PlayStation і консолі • релізи й анонси • новини індустрії • знижки. Шукаю джерела.

### Step 4: sources connected (§19–§23)

> 🚀 Стежу за 5 джерелами для **PlayStation Україна**:
> 1. PlayStation Blog — сайт · офіційні анонси PlayStation
> 2. @gamingnews_ua — Telegram · канал часто його пересилає
> 3. Eurogamer — RSS · новини й релізи за твоїми темами
> 4. PlayStation — YouTube · трейлери й анонси
> 5. VGC — RSS · новини індустрії
>
> Щоранку о 9:00 надсилатиму сюди дайджест — найкращі історії за добу. Усе інше буде в черзі.
> Щоб публікувати пости прямо в канал, підключи його в Налаштуваннях (можна будь-коли).
> [✕ 1] [✕ 2] [✕ 3] [✕ 4] [✕ 5]
> [📝 Профіль каналу] [📋 Черга] [⚙️ Підключити канал]

### Step 5: the daily digest (§24)

The existing digest message: the channel and period, counts, up to 5 recommended stories with Radar's reason and sources, a numbered button per story that opens its card, and "📋 Відкрити чергу". In the queue the user reviews as any reviewer does: Approve (popup until the channel is connected, §25), Reject, Edit, Send to preview.

## 6. Channel validation

1. `normalizeChannelUsername()`; invite links are rejected as private.
2. Bot API `getChat("@username")`: the type must be `channel` (groups, users and bots are rejected). Keep `id` (`-100…`) and `title`.
3. One read of `t.me/s/<username>`, which must have posts.

Failure: "Не можу прочитати цей канал. Перевір, що це публічний канал з @username." The session stays `awaiting_channel`.

## 7. Provisioning

1. Find or create the `user` by the Telegram identity (`provider = 'telegram'`, `subject` = Telegram user id).
2. If the user is already a member of a workspace whose `telegram_chat_id` equals the channel id, reuse it.
3. Otherwise create one:

```
name                    = channel title
telegram_chat_id        = -100<id>              (as operator workspaces store it)
telegram_admin_chat_id  = user's Telegram id     (where the digest goes)
workspace_members       = (workspace, user, 'owner')
auto_publish            = false
review_digest_minutes   = 1440                  (once a day, §24)
review_digest_hour      = 9
review_digest_timezone  = 'Europe/Kyiv' for uk, else 'UTC'   (changeable in Settings)
review_digest_sent_at   = now()                 (so the first digest is the next 09:00, not an empty one now)
channel_verified_at     = null                  NEW (§25; publishing needs it)
created_via             = 'self_service'        NEW
```

Several users may onboard the same public channel. It is public data. Only one who connects the channel (§25a), and so proves they administer it, can publish to it.

Migration for existing workspaces: `channel_verified_at = now()`, `created_via = 'operator'`. Their behaviour does not change.

## 8. Sessions and the step runner (D2)

```
onboarding_sessions
  id                serial pk
  user_id           → users, null until §7 (set null if the user goes)
  telegram_user_id  text
  chat_id           text                -- where progress goes
  workspace_id      → workspaces, null until §7
  channel_username  text
  channel_chat_id   text
  status            awaiting_channel | analyzing_history | profiling | discovering_sources
                    | activating_sources | active | failed
  attempts          int default 0       -- of the current step
  next_attempt_at   timestamptz         -- retry after 429 / transient errors
  locked_until      timestamptz         -- lease: one runner per step
  progress          jsonb               -- e.g. crawl cursor { before, inspected, usable }
  status_message_id bigint              -- the progress message, edited in place
  error_code, error_message text
  started_at, updated_at, completed_at
  language          'uk' | 'en'          -- the bot's copy, from the Telegram app
  channel_title     text
  UNIQUE (telegram_user_id) WHERE status NOT IN ('active','failed')
```

Runner:

- `runOnboardingStep(sessionId)` takes the lease (compare-and-set on `locked_until`), runs **one** step, commits the next status, and releases the lease.
- The webhook kicks only the first step (reading history, a few seconds) with `after()`, since a webhook may run 60 s at most.
- `GET /api/cron/onboarding` (every minute, cron-authorised, `maxDuration = 800`) runs every due step within its budget: the profiling, retries after a backoff, and any step whose lease expired. It is its own cron, so a slow profiling never delays scheduled publishing. (Built in step 3: there is no separate `/api/onboarding/run`.)
- Transient errors (`ChannelPageError.transient`, 429 with `retryAfterMs`, LLM timeouts) back off via `next_attempt_at`. After `ONBOARDING_MAX_ATTEMPTS` (5) the session fails with a message (§27).

Expected timing:

| Step | Work | Time |
|------|------|------|
| analyzing_history | 5–10 t.me pages, sequential, about 300 ms apart | 5–15 s |
| profiling | 1–2 note batches + profile; editorial profile + language; embeddings | 30–90 s |
| discovering_sources | link signals + one web-search call + validation of ≤ 25 candidates (concurrency 6, 10 s each, 60 s budget) | 40–90 s |
| activating_sources | 5 × `add*Source` | 5–20 s |

## 9. Public history crawl

- Target **100** usable posts (`usableForProfile`), the channel's latest; inspect at most **200** messages; stop at either, or when there is no older page. (D9: a recent picture of the channel, faster and cheaper. Link and forward signals in §15 come from these same 100 posts; web discovery makes up for the thinner signal.)
- Fewer than 30 usable posts: continue, with a note that recommendations may be less precise.
- Paging: `fetchChannelPage(username, { before })`, about 20 posts a page, 300 ms apart. A real channel takes 5 pages and about 2 s.
- A 429 with `Retry-After` up to 30 s is waited out in place. A longer one fails the step as transient, and the runner retries it later. A retry reads the channel again from the newest post, which costs a few seconds. Storing is an upsert by message id, so a retry never duplicates items. (Built in step 2: `src/lib/onboarding/telegram-history.ts`, `npm run history:crawl`.)

## 10. History storage

Never `processed_posts`; always `publication_history_items`.

Extract `storeParsedPublicationHistory({ db, workspaceId, parsed, importMeta, logger })` from `importPublicationHistory`. Both the file import and the crawl call it. No fake `result.json`.

Audit row in `publication_history_imports` for a crawl: `adapter = 'telegram-public'`, `original_filename = 't.me/s/<username>'`, `file_sha256` = SHA-256 of the items' canonical JSON. Both columns are NOT NULL, so this needs no migration.

`publicationKey` = `-100<id>`, **the same as `publicationKeyOf` in `src/lib/history/adapters/telegram-json.ts`**, so a later Desktop import upserts instead of duplicating. If the spike fails, use `tg:<username>`.

## 11. Item mapping

```
platform        = telegram
publicationKey  = -100<id>
publicationName = channel title
externalId      = message id
contentType     = from text / media, as telegram-json maps it
text            = textOf(post)
publishedAt     = <time datetime>; items with no date are skipped
canonicalUrl    = https://t.me/<username>/<id>
media           = [{ type, relativePath: null, available: false, durationSeconds? }]
metrics         = { views }
metadata        = { forwarded, forwardedFrom?, outboundLinks }
```

Forwards stay: they are what the channel chose to publish. t.me media URLs expire, so media is metadata only, and image understanding does not cover crawled history in v1.

## 12. Parser extensions

Optional fields on `ChannelPagePost`; live sync ignores them:

```ts
outboundLinks?: Array<{ url: string; label?: string }>;   // <a href> in the post's own text + its link-preview card
forwardedFrom?: { username: string; messageId?: number }; // .tgme_widget_message_forwarded_from a[href]
```

Exclude the post's own `t.me/<channel>/<id>`, t.me UI links, `tg://` and `mailto:`. Unwrap only redirects whose target is in the query (`l.facebook.com/l.php?u=`); never follow redirects here. Tests cover a text link, a preview card, a public forward, and a hidden-user forward.

## 13. Channel profile

`buildPublicationProfile()`, then embeddings: the same code as `history:profile` and `history:embed`. The profiler stays the authority on topics, angles, tone and format.

## 14. Initial `editorial_profile` and `language` (D3)

One LLM call (`initial-profile.ts`) over the publication profile returns:

- `editorialProfile`: at most 2,000 characters; describes what the channel publishes; no invented dislikes; an absent topic is not a rejection. Stored with `editorial_profile_source = 'auto'` (**new column**, `'auto' | 'editor'`). Saving in Settings sets `'editor'`.
- `languageCode`: BCP 47, written to `workspaces.language` if it passes `workspaces_language_check` and no language is set yet.
- `topics`: 3–4 main topics in the channel's language, for the progress message (the publication profile's own are in English).

A person's profile is never overwritten: only an empty one or one with `editorial_profile_source = 'auto'` is. That covers onboarding a channel whose workspace the person already belongs to (an operator's), which reuses that workspace (§7).

## 14a. Editing the editorial profile in the bot (D8)

The profile is what Radar scores against, so it decides what the digest recommends. The user must be able to change it without leaving the chat.

**Entry points:** the `/profile` command; a `[📝 Профіль каналу]` button on the "Стежу за" message (§23); a line in `/help`. With several workspaces, the bot first asks which channel, reusing the channel-choice keyboard (`buildChannelChoiceData`).

**Screen:**

> 📝 **Профіль каналу PlayStation Україна** (згенерований автоматично)
> <the profile text, at most 2,000 characters, fits one message>
> Мова постів: українська
> [✏️ Написати свій] [💬 Уточнити]
> [🌐 Мова] [⚙️ Налаштування]

- **✏️ Написати свій:** "Надішли новий текст профілю одним повідомленням (до 2000 символів)." The next plain-text message in that chat replaces the profile. Over 2,000 characters: refuse and say by how much.
- **💬 Уточнити:** "Напиши, що змінити — наприклад: «більше про інді-ігри, без знижок і розіграшів»." One LLM call (`refine-profile.ts`) rewrites the current profile to apply the instruction, within 2,000 characters. The bot shows the result with `[✅ Зберегти] [↩️ Скасувати] [💬 Ще уточнити]`. Here dislikes **are** allowed: the user stated them. The "no invented dislikes" rule applies only to auto-generation (§14).
- **🌐 Мова:** a short list (українська, English, as is / без перекладу, Інша… → the user types a code) sets `workspaces.language`.
- **⚙️ Налаштування:** the existing Settings Mini App.

Saving, from the bot or from Settings, goes through `setEditorialProfile` and sets `editorial_profile_source = 'editor'`. Radar uses the new profile from the next post it scores (its `editorialProfileHash` changes). Posts already scored are not re-scored. The confirmation says so: "Збережено. Нові пости оцінюватиму за оновленим профілем."

For a self-service workspace the profile **cannot be cleared**: an empty profile turns Radar off, and the digest would recommend nothing. Settings' "Clear" button is hidden for it and the API refuses (§33).

**Waiting for the next message.** A new table:

```
bot_pending_inputs
  telegram_user_id text pk      -- one pending prompt per user
  kind            'profile_replace' | 'profile_refine' | 'language_custom' | 'manual_source'
  workspace_id    → workspaces
  payload         jsonb          -- e.g. the refined draft awaiting ✅
  expires_at      timestamptz    -- 15 minutes
```

Message routing (§5a) checks it right after the onboarding session: a plain-text message with a live pending input is that input. A `/command` cancels it. Onboarding's `awaiting_channel` stays in `onboarding_sessions`.

## 15. Source discovery

Three signals:

**A. Links in history**, aggregated by source identity:
- `youtube.com/@h` and `/channel/UC…` → channel; `watch?v=`, `youtu.be/`, `/shorts/` → resolve the video's channel (§18)
- `t.me/<name>/…` → Telegram
- anything else → website, by registrable domain
- X links are counted for analytics only and never suggested

**B. Forwards in history.** `forwardedFrom.username` counts per channel. This is the strongest Telegram signal.

**C. AI + web search** (D6), one bounded call. Input: the publication profile, the editorial profile, top topics, and candidates from A and B. Ask for 10–15 reputable sources that regularly publish original information on these topics, in this priority: official/primary; specialist publications; niche curators; quality creators. Not only big generic media; platforms Telegram/YouTube/website only. Output is JSON (`name`, `platform`, `url`, `organization`, `reason`), validated with zod. Every URL is only a hint until §18 validates it.

**Noise filters for A and B:**
- at least 2 mentions or forwards;
- skip links in ad posts (`#реклама`, `#ad`, `#промо`, `партнерськ`, `sponsored`);
- blocklist: donations and payments (`send.monobank.ua`, `patreon`, `buymeacoffee`, `donatello`, `privat24`), shops and affiliates (`aliexpress`, `rozetka`, `amazon`, `prom.ua`), shorteners (`bit.ly`, `t.ly`, `goo.gl`; not followed in v1), app stores, `forms.gle`, Google Docs and Drive;
- never the channel itself or its own website. Its own website is a site **named like the channel** (`pravda.com.ua` for @ukrpravda_news) **and** linked from at least 25% of its posts. Either alone is not enough: a curator's main source is linked a lot (IGN for @playstationua), and a channel may be named after what it covers (blog.playstation.com). Its own YouTube channel (same name) is dropped after resolving.
- one outlet once: a Telegram channel and a site of the same name (@epravda and epravda.com.ua) are not both picked.
- `#реклама` and the like are matched with a Unicode-aware boundary (JavaScript's `\b` knows only Latin letters).

If C fails, continue with A and B. Never block onboarding.

## 16. Platforms in v1

Telegram, RSS/Atom, website (sitemap), YouTube. Not X, not Threads.

## 17. Resolving a website

`addWebsiteSource()` stays unchanged. A new `discoverSiteFeed(homepageUrl)` tries, in order:

1. **RSS/Atom**: `<link rel="alternate" type="application/(rss|atom)+xml">` on the homepage, on the site's own host first, then `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml`, then feeds the homepage announces on other hosts. A feed makes the candidate platform **`rss`**. Known limit: a site that redirects by the visitor's country (www.ign.com → cz.ign.com here, de.ign.com from Vercel's fra1) gives that edition's feed.
2. A **news sitemap** from `robots.txt` (URL contains `news`).
3. `robots.txt` `Sitemap:`, `/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, validated with `readSitemapTree`. A non-news sitemap at or above `LARGE_SITEMAP_URLS`, or truncated, is skipped.
4. Nothing valid: drop the candidate.

All fetches go through the existing private-address guards and timeouts.

## 18. Validation: resolve and persist

Split each `add-*` into a resolver with no DB writes, plus the existing persist step:

```ts
resolveTelegramSource → { platform:'telegram', externalId: username, displayName: title }
resolveYouTubeSource  → { platform:'youtube',  externalId: UC…,      displayName }
resolveRssSource      → { platform:'rss',      externalId: url,      displayName: feed title }
resolveWebsiteSource  → { platform:'website',  externalId: sitemap,  displayName: host }
resolveXSource        → kept for manual /addsource only
```

`addXxxSource` = resolve + `addSource`. Messages and behaviour are unchanged, and existing tests pass as they are.

YouTube videos: `getVideoChannel(videoId)` via `YouTubeClient.getVideos` (it has `channelId`), then `getChannel`. Without `YOUTUBE_API_KEY`, YouTube candidates are dropped.

Validation runs with concurrency 6, 10 s per candidate and 60 s in total. Anything still unchecked at the deadline is dropped.

## 19. Ranking and picking 5

Score:

```
1. forwarded / linked repeatedly by the channel (by count)
2. official / primary source strongly matching core topics
3. specialist publication
4. niche creator / curator
5. generic aggregator
```

Pick the top `SOURCES_AUTO_ACTIVATED` (5) with diversity: **at most 2 per platform, at most 1 per organisation** (registrable domain or the model's `organization`). Prefer a mix: at least one history-derived source when there is one, and at least one web-discovered source when there is one. The rest of the validated candidates are kept, ranked, as **reserve** for ➕ replacements (§23).

## 20. `source_suggestions`

```
source_suggestions
  id, session_id → onboarding_sessions, workspace_id → workspaces
  platform, external_id, display_name, url
  origin            history_link | history_forward | discovery | manual
  evidence_count    int
  reason            text            -- one line, from evidence
  rank              int
  state             active | reserve | removed | failed
  activated_source_id → sources, null
  activation_error  text
  created_at, updated_at
```

Rows stay after onboarding, for analytics: which origins survive, which get removed.

## 21. No selection step

There is no selection keyboard. The 5 picked are connected straight away (§22) and shown with ✕ (§23).

## 22. Activation

For each picked suggestion:

1. Run the platform's `add*Source` (it re-resolves).
2. Create or reuse the `sources` row (upsert).
3. Set `include_text_only = true` and `radar_threshold = null`. **Extend `addSource`** with optional `{ includeTextOnly, radarThreshold }`, applied on insert only. Nothing is dropped before it reaches the queue; the digest picks the best from it (§24).
4. A failure promotes the next reserve candidate, until 5 are active or the reserve runs out.

`following_since = now()`, so no backlog.

Fewer than 3 active after the reserve is used up: say so, and invite the user to send a website, Telegram channel or YouTube channel. Each reply goes through the same resolver and is added (`origin = manual`).

## 23. The "Стежу за" message

The message from §5, step 4. Each line has a reason drawn from the evidence ("канал пересилав його 14 разів", "офіційні анонси PlayStation; ти часто про це пишеш").

- `ob:rm:<suggestionId>` (✕): disable the source (the same pause as `/sourcestats`, `enabled = false`), mark the suggestion `removed`, and edit the message. If a reserve exists, append "Замість нього можу стежити за **Eurogamer** (RSS) — ми знайшли його за твоїми темами" with `[➕ Додати]` (`ob:add:<suggestionId>`).
- `[📋 Черга]` opens the existing review queue.
- `[⚙️ Підключити канал]` opens Settings at the Publishing channel block (§25a). It is left out once the channel is connected.
- `/sourcestats` and Settings work as for any workspace.

Never mention embeddings, RAG or Radar.

## 24. Notification: the existing daily digest (D1a)

Nothing new is built for delivery. A self-service workspace is provisioned with `review_digest_minutes = 1440`, `review_digest_hour = 9` and a time zone (§7), and the existing code does the rest:

- The sync cron calls `sendReviewDigest` for every workspace; `reviewDigestIsDue` makes it due at 09:00 local each day.
- `loadReviewDigest` reads the posts queued since the last digest, groups them into stories, and recommends up to `DIGEST_STORIES_MAX` (5) waiting stories by Radar score, each with Radar's reason and its sources. A story is shown in one digest at most.
- No new posts since the last one: no digest that day (`nothing-new`).
- Every post still goes through `processCandidate()`: Radar scores it, places it in its story, and it enters the queue (`awaiting_approval`). With a digest set there are no per-post review messages.
- The story buttons and "📋 Відкрити чергу" open the queue in the Mini App or on the website (`reviewLinkFor`), as for any reviewer.

The user can change the interval and hour in Settings like any workspace (§33). The "Стежу за" message (§23) says when the digest comes.

Prerequisite already in place: a reviewer only gets the digest once they have started the bot, which every self-service user has.

## 25. Publishing requires a connected channel

`telegram_chat_id` is set at provisioning (sync needs it: `listActiveWorkspaces`), so whether a workspace may publish is its own fact: **`channel_verified_at` is not null.** Gating `destinationFor` would also stop sync, so the check goes at the points that post to the channel:

- `publishDecidedPost` (`src/lib/sync/publish.ts`)
- `publishDueScheduledPosts` (`src/lib/sync/publish-scheduled.ts`): skip, do not fail (cannot happen in practice, since scheduling is refused too)
- the approve / schedule handlers in `src/app/api/telegram/webapp/queue`, `.../schedule`, the webhook's approve callback, and auto-publish (`auto_publish` cannot be turned on while not connected)

They refuse with **409 `{ code: 'channel_not_connected' }`**. The webhook's approve callback answers "Спершу підключи канал у Налаштуваннях" with a Settings button.

Preview is safe as it is: since D11 it only ever sends to the pressing reviewer's own bot chat, so it works without a channel.

**The popup.** The queue API returns `canPublish` per workspace. In the `ApproveDialog` (`src/components/review-queue.tsx`), and on the card's 🕒 Schedule, when `canPublish` is false:

- the dialog opens as usual; Send to preview works as usual;
- pressing **Publish now** or **Schedule** does not call the server. It opens a popup:

  > **Set up the channel your posts go to**
  > Zmistik can publish and schedule posts once it can post to {channel}. It takes a minute.
  > [Open Settings] [Not now]
  > Or send yourself a preview and post it by hand.

- **Open Settings** goes to Settings' "Publishing channel" block (`/settings?section=publishing-channel` in the Mini App, `/console/settings?section=publishing-channel` on the website — a query, since Telegram passes a Mini App its sign-in in the `#hash`);
- a 409 `channel_not_connected` from the server (a stale page, another tab) opens the same popup instead of the red error line.

The copy follows the UI's language (English today, Ukrainian once the UI is translated).

## 25a. Connecting the channel (D12)

Settings, for a workspace whose channel is not connected, shows at the top:

> **Publishing channel:** {title} (@username) — not connected
> 1. Add @ZmistikBot to the channel as an admin with **Post messages** (and Edit / Delete messages).
> 2. Press Check.
> [Check]

`POST /api/telegram/webapp/channels/verify` (owner only):

1. `getChatMember(channel, bot)`: status `administrator` with `can_post_messages`.
2. `getChatMember(channel, user's Telegram id)`: `creator`, or `administrator` with `can_post_messages`.
3. Both pass → `channel_verified_at = now()`. The block shows "✅ Connected", and the popup no longer appears.
4. Otherwise a precise message: "The bot is not an admin of the channel yet", "The bot cannot post: turn on Post messages", "You are not an admin of this channel".

Also: the webhook subscribes to `my_chat_member` (add it to `allowed_updates` in `setWebhook`). When the bot becomes an admin of a channel that is some workspace's unconnected `telegram_chat_id`, it runs the same check for that workspace's owner and, on success, writes to them: "✅ Канал підключено — тепер можна публікувати й планувати прямо зі Змістика." When it loses admin rights, nothing is unset automatically: publishing then fails with Telegram's own error, as it does for operator workspaces today.

Connecting changes only `channel_verified_at`. The notification setting, sources and queue stay as they are. Auto-publish becomes available in Settings.

## 26. Learning

Approve (published / scheduled) and Reject with reason are Radar's evidence, through the existing paths. Until the channel is connected a self-service user cannot approve, so Radar learns only from their rejections and from the onboarded history. Send to preview is not a signal. No parallel model.

## 27. Errors

| Case | Behaviour |
|------|-----------|
| Not a public channel | Message from §6; the session stays `awaiting_channel` |
| t.me 429 / timeout | Reschedule; tell the user once: "Telegram обмежує запити — продовжу автоматично." |
| Profiling fails after retries | The workspace and history stay. "Історію завантажив, але профіль не вийшов." [Спробувати ще] reruns `profiling` |
| Web discovery fails | Continue with history signals only |
| A source fails to activate | Promote the next reserve candidate |
| Fewer than 3 sources | Ask for manual sources (§22) |
| Publish / schedule without a connected channel | The popup (§25); the server answers 409 `channel_not_connected` |
| Check fails (§25a) | The reason, in Settings; nothing changes |
| Cap reached (D5) | "Змістик зараз у закритій альфі — ти в списку." + `onboarding.waitlisted` |

## 28. Limits (`src/lib/onboarding/limits.ts`; caps overridable by env)

```
HISTORY_TARGET_USABLE_POSTS     100
HISTORY_MAX_MESSAGES_SCANNED    200
HISTORY_MIN_USEFUL_POSTS         30
SOURCES_AUTO_ACTIVATED            5
SOURCES_RESERVE_MAX              10
DIGEST_MINUTES_DEFAULT         1440   (self-service)
DIGEST_HOUR_DEFAULT               9
ONBOARDING_ACTIVE_PER_USER        1
ONBOARDING_WORKSPACES_PER_USER    3   (self-service)
ONBOARDING_MAX_WORKSPACES        50   (global)
ONBOARDING_MAX_RUNS_PER_DAY      30   (global)
ONBOARDING_ALLOWLIST             unset: off; comma-separated Telegram ids; or * for anyone
ONBOARDING_MAX_ATTEMPTS           5
DISCOVERY_VALIDATION_BUDGET_MS 60000
```

Known limit, not addressed in v1: one sync cron runs every tenant in sequence (560 s budget, rotation), and sources are not shared between workspaces. Watch `stoppedForTime` / `deferred` as tenants grow.

## 29. Analytics (D7)

```
product_events
  id, occurred_at, name text, user_id, workspace_id, session_id, props jsonb
  index (name, occurred_at)
```

Events:
- `onboarding.started`, `.channel_submitted`, `.channel_validated`, `.history_completed` {usable, inspected}, `.profile_completed`, `.discovery_completed` {by_origin}, `.sources_activated` {count, by_origin}, `.source_failed` {platform, reason}, `.completed`, `.failed` {step, code}, `.waitlisted`
- `source.removed` {origin}, `source.replaced`
- `digest.sent` {recommended, shown} (self-service workspaces)
- `queue.opened` {from: digest | sources | command}
- `post.previewed`, `post.rejected` {reason}, `post.approved`
- `publish.blocked` {action: publish | schedule} (the popup shown), `publish.popup_settings` (Open Settings pressed)
- `channel.check` {result: connected | bot_not_admin | bot_cannot_post | user_not_admin}, `channel.connected` {via: check | my_chat_member}

## 30. Metrics

Funnel: `/start` → channel submitted → analysed → 5 sources active → first digest → first queue open from a digest → first preview or reject → channel connected → first publish → active on day 7.

Directional targets:
- 70% of valid submissions reach active sources;
- 80% of those get a digest within 36 h;
- 50% open the queue from a digest in week one;
- 30% connect the channel in week one (of those shown the popup: 50%).

Quality signals: digest → queue open rate; share of recommended stories that get previewed or approved; the source removal rate by origin.

## 31. Acceptance criteria

1. A new user: `/start` → `@channel` → validated (groups, users, bots and invite links rejected).
2. The user, the workspace (`self_service`, `channel_verified_at = null`, `review_digest_minutes = 1440`, `review_digest_hour = 9`, a time zone) and the owner membership are created.
3. The latest 100 usable posts (or all of them, if fewer) are in `publication_history_items` under `-100<id>`, with an import audit row; nothing is in `processed_posts`.
4. The profile and embeddings exist; `editorial_profile` (`auto`) and `language` are set.
5. 5 validated sources (no X, no Threads) are active with `include_text_only = true`; no backlog; the "Стежу за" message is shown.
6. ✕ disables a source and offers a reserve; ➕ activates it.
7. New items go through `processCandidate()`, are scored and clustered, and enter the queue. No per-post review messages are sent.
8. The digest goes out once a day at 09:00 local with Radar's top stories; none on a day with nothing new; none right after onboarding.
9. Without a connected channel: Approve → Publish now and Schedule open the popup and send nothing; Open Settings lands on the Publishing channel block; Send to preview delivers the post to the user's bot chat.
10. **No path publishes to an unconnected channel**: approve, schedule, scheduler, webhook approve and auto-publish all refuse (409 `channel_not_connected`) for `channel_verified_at = null`. Tested, including a channel where the bot already is an admin for another workspace.
11. Check in Settings connects only when the bot can post **and** the user is the creator or a posting admin; each failure has its own message. Adding the bot as admin connects it via `my_chat_member` and tells the owner. After connecting, Publish and Schedule work with no other change.
12. A crash or a long 429 mid-crawl is retried by the sweeper; a short 429 is waited out; no duplicate items.
13. Two runner calls for one session: only one runs the step.
14. Operator workspaces behave exactly as before (migration defaults), and existing `add-*` tests pass unchanged.
15. `/profile` shows the profile. ✏️ replaces it with the next message, 💬 rewrites it from an instruction and saves only on ✅, 🌐 sets the language. Every save sets `editorial_profile_source = 'editor'`, and the next scored post uses the new profile. A self-service workspace's profile cannot be cleared from the bot, Settings, or the API.
16. Settings has a Language field for every workspace.

## 32. Layout and order

```
src/lib/onboarding/
  limits.ts             §28
  session.ts            table access, lease, transitions
  runner.ts             runOnboardingStep, retries, sweeper
  routing.ts            §5a
  messages.ts           uk/en copy
  workspace.ts          §7
  telegram-history.ts   §9
  initial-profile.ts    §14
  link-signals.ts       §15 A/B + noise filters
  source-discovery.ts   §15 C
  site-feed.ts          §17
  ranking.ts            §19
  activate-sources.ts   §22, §23
src/lib/publishing/channel.ts         §25 canPublish / gate, §25a check (getChatMember ×2)
src/app/api/telegram/webapp/channels/verify/route.ts   §25a
src/components/review-queue.tsx       §25 popup in ApproveDialog and 🕒 Schedule
src/components/settings-panel.tsx     §25a Publishing channel block, language field
src/lib/profile/bot-profile.ts        §14a /profile screen, replace / refine / language
src/lib/profile/refine-profile.ts     §14a LLM rewrite from an instruction
src/lib/telegram/pending-input.ts     §14a bot_pending_inputs
src/lib/history/store-history.ts      §10
src/lib/telegram-channel/parser.ts    §12
src/lib/sources/add-*.ts              §18 resolve / persist
src/lib/sources/repository.ts         §22 addSource options
src/app/api/onboarding/run/route.ts   §8
src/db/schema.ts + migration          onboarding_sessions, source_suggestions, product_events,
                                      bot_pending_inputs; workspaces.channel_verified_at,
                                      created_via, editorial_profile_source
```

Order (each step shippable and tested on its own):

1. Schema + publishing gate + popup + connecting the channel (§25, §25a). Closes the hole before anyone can self-serve, and is useful on its own.
2. Parser extensions + `storeParsedPublicationHistory` + crawl (§9–§12), runnable from a script.
3. Sessions, runner, routing, provisioning (§5a, §7, §8) up to "profile done", + initial profile/language (§14).
4. Resolve/persist split, site-feed discovery, link signals, web discovery, ranking (§15–§19). **Built**: `src/lib/onboarding/{candidates,link-signals,site-feed,source-discovery,discover-sources}.ts`; `npm run onboarding:discover -- --workspace N --channel @name [--no-search]` prints what would be connected. The web search uses `ASSISTANT_MODEL`.
5. Auto-activation + the "Стежу за" message with ✕/➕ (§20–§23). **Built**: `source_suggestions` (migration 0051), `src/lib/onboarding/{activate-sources,following}.ts`; the runner's `discovering_sources` and `activating_sources` steps; `ob:rm` / `ob:add` callbacks in the webhook. Fewer than 3 connected: the message points to the existing `/addtelegram`, `/addyoutube`, `/addrss`, `/addwebsite` (the person is the workspace's reviewer by then), rather than a separate manual-source input. A live run on @playstationua took 50 s from history to the message.
6. `/profile` in the bot: replace, refine, language (§14a); the language field in Settings (§33). **Built**: `bot_pending_inputs` (migration 0052; kinds `profile_replace`, `profile_refine`, `language_custom` — `manual_source` was not needed, see step 5), `src/lib/telegram/pending-input.ts`, `src/lib/profile/{bot-profile,refine-profile}.ts`, `src/lib/workspace-language.ts`; `pf:` callbacks and a `[📝 Профіль каналу]` button on the "Стежу за" message. A pending input is checked **before** onboarding's routing, not after: it exists only because the person pressed a button in the last 15 minutes. After a draft, a plain message refines the draft further (💬 Ще уточнити only prompts for it). The rewrite runs after the webhook answers. Settings: a 🌐 Language section (Ukrainian, English, as is, Other → a code checked with `Intl`), an `auto` badge on the profile, no Clear for a self-service channel, and the API refuses to clear it (422).
7. Limits, waitlist, analytics (§28–§29). **Built**: migration 0053 (`product_events`, `onboarding_waitlist`); `src/lib/onboarding/access.ts`, `src/lib/analytics/track.ts`, `POST /api/telegram/webapp/events` (only `queue.opened`, `publish.blocked`, `publish.popup_settings`, each with its own props), `npm run onboarding:waitlist [-- --all | --admit <id>]`, `npm run events:funnel [-- --days N]`. The caps are env: `ONBOARDING_MAX_WORKSPACES` (50), `ONBOARDING_MAX_RUNS_PER_DAY` (30), `ONBOARDING_WORKSPACES_PER_USER` (3). `ONBOARDING_ALLOWLIST`: unset — onboarding off, the bot answers strangers as before; a list — those people, and anyone else's /start is waitlisted; `*` — anyone, up to the caps. Admitting from the waitlist lets a person past the allowlist, never past a cap, and the bot tells them. A run is a session that got a channel; the caps are checked at /start and again when the channel arrives. Queue links carry `from=digest|sources|command` for `queue.opened`. Also recorded: `profile.saved`, `profile.language_set`.

The digest (§24) needs no step: provisioning sets its columns.

## 33. The website and Mini App under the new logic (D10)

There is no separate app and no mode. Every page already works per workspace (a reviewer of several channels switches between them), and a self-service workspace uses the same pages with the same buttons. The only question a page asks is **is the channel connected?** (`channel_verified_at`, §25). Operator workspaces are, so they see no change.

**Access.** The self-service user is the workspace's `owner` member, with their Telegram identity. They sign in to `/console` with Telegram (OIDC) and open the Mini Apps from the digest's buttons, as reviewers do now. `findWorkspacesByAdminChatId` and `workspacesForUser` require `telegram_chat_id`, which is set at provisioning (§7).

| Page | Channel connected (today, unchanged) | Not connected yet |
|------|--------------------------------------|-------------------|
| **Review queue**: `/console/queue`, Mini App `/queue` | As today | The same cards and buttons. Approve dialog: Publish now / Schedule → the popup (§25); Send to preview works. Card's 🕒 Schedule → the popup |
| **Single post review**: Mini App `/review` | As today | Approve → the popup; Reject as today |
| **Scheduled**: `/console/scheduled`, `/scheduled` | As today | Empty (nothing can be scheduled); the empty state links to the Publishing channel block |
| **Editor** | As today | As today; finishing goes through the same Approve dialog |
| **Sources**, **Stats** | As today | As today. Onboarded sources carry "знайдено автоматично" (from `source_suggestions`) |
| **Settings** | As today, plus Language | **Publishing channel** block at the top (§25a); auto-publish shown disabled, "connect the channel first"; Language; everything else as today |
| Bot commands | As today | `/scheduled`: "Щоб планувати пости, підключи канал у Налаштуваннях." `/help` lists `/profile`, `/sourcestats`, `/review`, `/newchannel` |
| `/api/status` | Per-tenant publishability | Reports them as "channel not connected", not "unpublishable" |

**For every workspace:**
- **Language** is a new Settings field. Today it can be set nowhere in the UI.
- The editorial profile shows an "auto" badge while `editorial_profile_source = 'auto'`. A self-service workspace's profile cannot be cleared (§14a).

**A user with both kinds of workspace** sees the popup only on the unconnected one. Every card, callback and page decides by the post's workspace, never by the user.

**Server side.** The popup is a courtesy, not the protection. The publish gate (§25) refuses on the server, and the auto-publish route refuses to turn it on for an unconnected channel.

The product principle stays: **never ask for sources before Zmistik has done any work.**
