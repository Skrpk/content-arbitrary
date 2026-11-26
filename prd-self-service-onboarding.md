# PRD — Self-Service Telegram Onboarding & Source Discovery v1

Product: Zmistik
Feature: Telegram bot onboarding → channel analysis → automatic sources → best posts pushed to the bot
Version: v1, revision 3 (checked against the repository on 2026-11-26)
Primary interface: `@ZmistikBot` private chat

> **Revision 3** replaces the "select sources, then get a digest" loop with a
> shorter one decided on 2026-11-26:
>
> **channel → analysis → editorial profile → 5 sources connected automatically
> (no X) → the best posts arrive in the bot one by one, with 👍 / 👎 /
> «Зробити пост».**
>
> v1 never publishes to the channel. All decisions are made (§0).

---

## 0. Decisions

| # | Decision | Resolution |
|---|----------|------------|
| D1 | What the user gets, and publishing | Discovery-only. The bot connects 5 sources automatically and pushes Radar's best posts into the user's private chat, each with 👍 / 👎 / «Зробити пост». **Nothing is published to the channel in v1.** Publishing stays hard-gated (§25) so a self-service workspace can never post to a channel, including one the bot already administers for someone else |
| D1a | Delivery | Each post is its own message, sent as it arrives, but **only when Radar scores it at or above `push_min_score` (default 60)**. At most **`push_daily_limit` (default 15)** messages a day, and at most one per story. Everything else stays in the review queue |
| D1b | Buttons | 👍 = a positive decision (new status `liked`, counted as approval by Radar); 👎 = the existing reject-with-reason flow; «Зробити пост» opens the existing editor with a ready text, and «Надіслати мені» sends the finished post into the bot chat, where the user forwards or copies it to their channel |
| D1c | Sources | Exactly 5 picked automatically and connected at once (fewer if fewer pass validation). Then a "Стежу за: …" message where each source has ✕ to remove it; after a removal the bot offers the next-best candidate with ➕ |
| D2 | Where the long steps run | A step runner over `onboarding_sessions`. The webhook kicks it with `after()`, `/api/onboarding/run` runs one step per call (`maxDuration` 800), and the every-minute cron sweeps up stalled or retrying sessions. No external queue |
| D3 | Language | Set `workspaces.language` automatically (BCP 47) from the history |
| D4 | X | Never suggested in v1. Threads isn't either |
| D5 | Alpha gate | Global cap of 50 self-service workspaces, at most 30 onboarding runs a day, an optional allowlist; past a cap, a waitlist message |
| D6 | Discovery model | OpenAI Responses with `web_search`, as `src/lib/assistant/openai.ts` |
| D7 | Analytics | New `product_events` table |

**Spike before §6:** confirm that Bot API `getChat("@username")` returns `id`, `type` and `title` for a public channel the bot is **not** in. Fallback if it doesn't: validate and take the title from the t.me page, and key history by `tg:<username>` (§10).

---

## 1. Problem

Zmistik already has the intelligence layer: multi-tenant workspaces; Telegram/X/RSS/YouTube/website/Threads sources; publication history with profiles and embeddings; Shadow Radar; story clustering; the review queue.

But an operator still creates every workspace and configures every source by hand. The first experience should instead be:

```
/start → send your channel → Zmistik reads its public history → understands it
→ connects 5 sources on its own → starts sending you the posts worth your time
```

The user never meets tenants, embeddings, Radar, RSS or sitemaps.

## 2. Goal

From opening `@ZmistikBot` to receiving the first relevant post, without leaving Telegram and without configuring anything.

- Under 3 minutes from submitting the channel to "Стежу за 5 джерелами" (tight, see §8).
- The first pushed post normally arrives within hours, depending on source activity.

## 3. Non-goals for v1

Publishing to the channel (any path); a source-selection step; billing; referrals; Instagram/TikTok; private channels; competitor analysis; crawling the web; X or Threads in discovery; changing sources automatically after onboarding.

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
| Radar | `src/lib/radar/shadow.ts` `runLiveRadar`, run inline in `src/lib/sync/process-candidate.ts` **before review**, along with story placement | the score exists when delivery is decided, so §24 can push on it |
| Radar's positive evidence | `APPROVED_STATUSES` in `src/lib/radar/repository.ts` (`published`, `scheduled`) | add `liked` (§26) |
| Radar needs a profile | `workspaces.editorial_profile`; null = Radar off | hence §14 |
| Reject with reason | `buildRejectReasonKeyboard`, `rejectWithReason` (`src/lib/sync/approval.ts`, `repository.ts`) | reused for 👎 |
| Editor, send-to-preview | `src/app/api/telegram/webapp/rich`, `.../preview`, `previewPost` in `src/lib/sync/publish.ts` | reused for «Зробити пост» / «Надіслати мені» |
| Chat checks | `TelegramClient.getChat / getChatMember / getMe`; `src/lib/review/preview-channel.ts` | |
| Fetch safety | `isPrivateAddress` (`src/lib/rss/url.ts`), `src/lib/website/http.ts` | every discovery fetch goes through them |

Principle: **onboarding discovers and orchestrates; existing systems stay authoritative.** No second monitor, scorer or source store.

---

## 5. Flow

### Step 1: `/start`

For a user with no workspace and no active session:

> 👋 Привіт! Я Змістик.
> Надішли мені публічний Telegram-канал, для якого ти робиш контент. Я проаналізую, що він публікує, сам знайду джерела й надсилатиму тобі новини, які варто взяти в роботу.
> Формат: `@channelname` або `https://t.me/channelname`

Accepted: `@channel`, `t.me/channel`, `https://t.me/channel`, `https://t.me/channel/123`, `https://t.me/s/channel`. Copy is in Ukrainian when `language_code` starts with `uk`, otherwise English. This replaces `strangerGreeting` in private chats.

### 5a. Message routing (new)

`handleCommandMessage` (`src/app/api/telegram/webhook/route.ts`) currently ignores non-command text. Commands and callbacks are handled only for existing reviewers, and `/start` from a reviewer returns help. Onboarding gets its own routing, **checked before the reviewer lookup**:

1. Private chats only (`chat.type === 'private'`).
2. `/start`:
   - with an active session, repeat its current prompt or status;
   - with no workspace, start onboarding;
   - with a workspace, show help (plus a line about `/newchannel`).
3. `/newchannel`: onboard another channel, within the per-user limit (§28).
4. Plain text while the session is `awaiting_channel`: treat it as the channel.
5. `ob:` callbacks (onboarding) and `fb:` callbacks (feedback on pushed posts, §24) are handled before the reviewer check. They are authorised by the session's or workspace's owner Telegram id.

### Step 2: validation (§6)

> ✅ Знайшов **NAUKA.UA**. Аналізую останні пости — зазвичай це пару хвилин.

### Step 3: analysis progress (one message, edited in place)

> ✅ Проаналізував 287 постів. Канал переважно про: • PlayStation і консолі • релізи й анонси • новини індустрії • знижки. Шукаю джерела.

### Step 4: sources connected (§19–§23)

> 🚀 Стежу за 5 джерелами для **PlayStation Україна**:
> 1. PlayStation Blog — сайт · офіційні анонси PlayStation
> 2. @gamingnews_ua — Telegram · канал часто його пересилає
> 3. Eurogamer — RSS · новини й релізи за твоїми темами
> 4. PlayStation — YouTube · трейлери й анонси
> 5. VGC — RSS · новини індустрії
>
> Надсилатиму сюди лише те, що найбільше пасує каналу — до 15 постів на день. Решта буде в черзі.
> [✕ 1] [✕ 2] [✕ 3] [✕ 4] [✕ 5]
> [📋 Черга]

### Step 5: pushed posts (§24)

Each one is a normal review-style message (media, text, source mark, the Radar line), with:

```
[👍] [👎] [✍️ Зробити пост]
```

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
telegram_admin_chat_id  = user's Telegram id     (where pushed posts go)
workspace_members       = (workspace, user, 'owner')
auto_publish            = false
delivery_mode           = 'bot_push'            NEW (§24)
push_min_score          = 60                    NEW
push_daily_limit        = 15                    NEW
channel_verified_at     = null                  NEW (§25; publishing impossible)
created_via             = 'self_service'        NEW
```

Several users may onboard the same public channel. It is public data, and none of them can publish.

Migration for existing workspaces: `delivery_mode = 'channel_review'`, `channel_verified_at = now()`, `created_via = 'operator'`. Their behaviour does not change.

## 8. Sessions and the step runner (D2)

```
onboarding_sessions
  id                serial pk
  user_id           → users
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
  UNIQUE (user_id) WHERE status NOT IN ('active','failed')
```

Runner:

- `runOnboardingStep(sessionId)` takes the lease (compare-and-set on `locked_until`), runs **one** step, commits the next status, and releases the lease.
- The webhook kicks it with `after()`. `POST /api/onboarding/run` (cron-authorised, `maxDuration = 800`) runs a step and chains the next.
- The every-minute cron sweeps sessions with an expired lease or a due `next_attempt_at`.
- Transient errors (`ChannelPageError.transient`, 429 with `retryAfterMs`, LLM timeouts) back off via `next_attempt_at`. After `ONBOARDING_MAX_ATTEMPTS` (5) the session fails with a message (§27).

Expected timing:

| Step | Work | Time |
|------|------|------|
| analyzing_history | 15–25 t.me pages, sequential, about 300 ms apart | 15–40 s |
| profiling | 3–6 note batches (concurrency 4) + merge + profile; editorial profile + language; embeddings | 60–150 s |
| discovering_sources | link signals + one web-search call + validation of ≤ 25 candidates (concurrency 6, 10 s each, 60 s budget) | 40–90 s |
| activating_sources | 5 × `add*Source` | 5–20 s |

## 9. Public history crawl

- Target 300 usable posts (`usableForProfile`); inspect at most 500; stop at either, or when there is no older page.
- Fewer than 30 usable posts: continue, with a note that recommendations may be less precise.
- Paging: `fetchChannelPage(username, { before })`. The cursor lives in `progress`, so a retry resumes rather than restarts.
- Honour `retryAfterMs`. A 429 reschedules the step; the crawl never restarts.

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
- `languageCode`: BCP 47, written to `workspaces.language` if it passes `workspaces_language_check`.

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
- never the channel itself or its own website.

If C fails, continue with A and B. Never block onboarding.

## 16. Platforms in v1

Telegram, RSS/Atom, website (sitemap), YouTube. Not X, not Threads.

## 17. Resolving a website

`addWebsiteSource()` stays unchanged. A new `discoverSiteFeed(homepageUrl)` tries, in order:

1. **RSS/Atom**: `<link rel="alternate" type="application/(rss|atom)+xml">` on the homepage, then `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml`. A feed makes the candidate platform **`rss`**.
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
3. Set `include_text_only = true` and `radar_threshold = null`. **Extend `addSource`** with optional `{ includeTextOnly, radarThreshold }`, applied on insert only. In `bot_push` mode filtering is done by `push_min_score` (§24), never by `radar_threshold`, so nothing is dropped before it reaches the queue.
4. A failure promotes the next reserve candidate, until 5 are active or the reserve runs out.

`following_since = now()`, so no backlog.

Fewer than 3 active after the reserve is used up: say so, and invite the user to send a website, Telegram channel or YouTube channel. Each reply goes through the same resolver and is added (`origin = manual`).

## 23. The "Стежу за" message

The message from §5, step 4. Each line has a reason drawn from the evidence ("канал пересилав його 14 разів", "офіційні анонси PlayStation; ти часто про це пишеш").

- `ob:rm:<suggestionId>` (✕): disable the source (the same pause as `/sourcestats`, `enabled = false`), mark the suggestion `removed`, and edit the message. If a reserve exists, append "Замість нього можу стежити за **Eurogamer** (RSS) — ми знайшли його за твоїми темами" with `[➕ Додати]` (`ob:add:<suggestionId>`).
- `[📋 Черга]` opens the existing review queue.
- `/sourcestats` and Settings work as for any workspace.

Never mention embeddings, RAG or Radar.

## 24. Delivery: best posts pushed to the bot (D1a)

New workspace columns:

```
delivery_mode     text  'channel_review' (default; today's behaviour) | 'bot_push'
push_min_score    int   1–100, default 60
push_daily_limit  int   1–100, default 15
```

In `bot_push`:

- Every candidate goes through `processCandidate()` as today: Radar scores it, it is placed in its story, and it enters the review queue (`awaiting_approval`). Nothing is dropped by a threshold.
- **Push decision**, made right after Radar in `process-candidate.ts` (where `findReviewScore` already runs). Push when **all** of these hold:
  - the Radar score is at or above `push_min_score` (no score → no push);
  - no post of the same story was pushed in the last 48 h (story from `story_posts`);
  - fewer than `push_daily_limit` posts were pushed in the last 24 h (count of `pushed_at`).
- A pushed post is sent to `telegram_admin_chat_id` as today's per-post review message (`formatReviewControlText`, media, source mark, Radar note), **with the `bot_push` keyboard instead of Approve/Reject**:

  ```
  [👍] [👎] [✍️ Зробити пост]
  ```

  It records `processed_posts.pushed_at` (**new column**) and the message in `review_copies`, as today.
- The queue's periodic digest notification is **off** in `bot_push`: the push is the notification. The queue stays reachable from 📋 and from each pushed post.
- Not pushed = stays in the queue, unannounced.
- Quiet hours are not in v1.

Callbacks (`fb:` prefix, authorised as workspace members, scoped to the post's workspace like the existing callbacks):

| Button | Effect |
|--------|--------|
| 👍 `fb:up:<postId>` | `awaiting_approval` → **`liked`** (new status); the keyboard becomes `[✓ 👍] [✍️ Зробити пост]` |
| 👎 `fb:down:<postId>` | the existing reject-reason keyboard (`buildRejectReasonKeyboard`), then `rejectWithReason` |
| ✍️ `fb:edit:<postId>` | open the existing rich editor Mini App for the post (web_app button, so it opens in place). The Approve dialog's publish and schedule actions are hidden in `bot_push`; **«Надіслати мені»** sends the finished post (media + text, the workspace's footer) to the user's own chat through `previewPost`, so they can forward it (hide sender) or copy it. Opening the editor marks the post `liked` if it is still awaiting |

`liked` (new `post_status` value, migration `ALTER TYPE … ADD VALUE`) is:

- added to `APPROVED_STATUSES` in `src/lib/radar/repository.ts`, so Radar learns from it exactly like an approval;
- treated as decided everywhere statuses are switched on: queue views, stats (`src/lib/sources/stats.ts`), `alreadySettledNotice`. Grep for `'scheduled'` / `'published'` to find them.

Queue view in `bot_push`: show 👍 / 👎 / edit instead of Approve / Schedule.

## 25. Publishing is impossible in v1

`telegram_chat_id` is set (sync needs it: `listActiveWorkspaces`), so the gate must be explicit. A workspace with `channel_verified_at = null` may not send anything to its channel. Gating `destinationFor` would also stop sync, so the gate goes at the points that post to the channel:

- `publishDecidedPost` (`src/lib/sync/publish.ts`)
- `publishDraft` / `publishDueDrafts` (`src/lib/drafts/drafts.ts`)
- `publishDueScheduledPosts` (`src/lib/sync/publish-scheduled.ts`): skip, do not fail
- the approve / schedule handlers in `src/app/api/telegram/webapp/queue`, `.../schedule`, and the webhook's approve callback

They refuse with `channel_not_connected`.

The preview channel: in `bot_push`, Settings hides it, and the preview route refuses any target other than the user's own chat. That closes the same hole for `checkPreviewChannel`, which checks only the bot.

Connecting a channel for publishing comes later (v2): the bot must be an admin that can post, **and the user must be the creator or an admin who can post** (`getChatMember` on both), and only then is `channel_verified_at` set.

## 26. Learning

👍 (`liked`) and 👎 (rejection with reason) are Radar's evidence, through the existing approved/rejected paths. No parallel model.

## 27. Errors

| Case | Behaviour |
|------|-----------|
| Not a public channel | Message from §6; the session stays `awaiting_channel` |
| t.me 429 / timeout | Reschedule; tell the user once: "Telegram обмежує запити — продовжу автоматично." |
| Profiling fails after retries | The workspace and history stay. "Історію завантажив, але профіль не вийшов." [Спробувати ще] reruns `profiling` |
| Web discovery fails | Continue with history signals only |
| A source fails to activate | Promote the next reserve candidate |
| Fewer than 3 sources | Ask for manual sources (§22) |
| Cap reached (D5) | "Змістик зараз у закритій альфі — ти в списку." + `onboarding.waitlisted` |

## 28. Limits (`src/lib/onboarding/limits.ts`; caps overridable by env)

```
HISTORY_TARGET_USABLE_POSTS     300
HISTORY_MAX_MESSAGES_SCANNED    500
HISTORY_MIN_USEFUL_POSTS         30
SOURCES_AUTO_ACTIVATED            5
SOURCES_RESERVE_MAX              10
PUSH_MIN_SCORE_DEFAULT           60
PUSH_DAILY_LIMIT_DEFAULT         15
PUSH_STORY_WINDOW_HOURS          48
ONBOARDING_ACTIVE_PER_USER        1
WORKSPACES_PER_USER               3   (self-service)
ONBOARDING_MAX_WORKSPACES        50   (global)
ONBOARDING_MAX_RUNS_PER_DAY      30   (global)
ONBOARDING_ALLOWLIST             optional, comma-separated Telegram ids
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
- `push.sent` {score}, `push.capped` (the daily limit hit)
- `post.liked`, `post.disliked` {reason}, `post.editor_opened`, `post.sent_to_self`
- `queue.opened` {from: push | sources | command}

## 30. Metrics

Funnel: `/start` → channel submitted → analysed → 5 sources active → first push → first 👍/👎/edit → active on day 7.

Directional targets:
- 70% of valid submissions reach active sources;
- 70% of those get a push within 24 h;
- 40% react to a push in week one;
- 25% use «Зробити пост» in week one.

Quality signals: share of pushes getting 👍 or «Зробити пост» (target above 40%), and the source removal rate by origin.

## 31. Acceptance criteria

1. A new user: `/start` → `@channel` → validated (groups, users, bots and invite links rejected).
2. The user, the workspace (`bot_push`, `self_service`, `channel_verified_at = null`) and the owner membership are created.
3. About 300 posts are in `publication_history_items` under `-100<id>`, with an import audit row; nothing is in `processed_posts`.
4. The profile and embeddings exist; `editorial_profile` (`auto`) and `language` are set.
5. 5 validated sources (no X, no Threads) are active with `include_text_only = true`; no backlog; the "Стежу за" message is shown.
6. ✕ disables a source and offers a reserve; ➕ activates it.
7. New items go through `processCandidate()`, are scored and clustered, and enter the queue.
8. Only posts at or above `push_min_score` are pushed; at most 15 a day; at most one per story in 48 h; no queue digest is sent.
9. 👍 → `liked`, which Radar's evidence query returns as approved; 👎 → a rejection with reason; ✍️ opens the editor; «Надіслати мені» delivers the post to the user's chat.
10. **No path publishes to the channel**: approve, schedule, draft, scheduler, webhook, and the preview to a foreign chat are all refused for `channel_verified_at = null`. Tested, including a channel where the bot already is an admin.
11. A crash or 429 mid-crawl resumes from the cursor via the sweeper; no duplicate items.
12. Two runner calls for one session: only one runs the step.
13. Operator workspaces behave exactly as before (migration defaults), and existing `add-*` tests pass unchanged.

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
src/lib/delivery/push.ts              §24 push decision + keyboard + fb: callbacks
src/lib/history/store-history.ts      §10
src/lib/telegram-channel/parser.ts    §12
src/lib/sources/add-*.ts              §18 resolve / persist
src/lib/sources/repository.ts         §22 addSource options
src/app/api/onboarding/run/route.ts   §8
src/db/schema.ts + migration          onboarding_sessions, source_suggestions, product_events;
                                      workspaces.delivery_mode, push_min_score, push_daily_limit,
                                      channel_verified_at, created_via, editorial_profile_source;
                                      processed_posts.pushed_at; post_status += 'liked'
```

Order (each step shippable and tested on its own):

1. Schema + publishing gate (§25). Closes the hole before anyone can self-serve.
2. Parser extensions + `storeParsedPublicationHistory` + crawl (§9–§12), runnable from a script.
3. Sessions, runner, routing, provisioning (§5a, §7, §8) up to "profile done", + initial profile/language (§14).
4. Resolve/persist split, site-feed discovery, link signals, web discovery, ranking (§15–§19).
5. Auto-activation + the "Стежу за" message with ✕/➕ (§20–§23).
6. `bot_push` delivery, `liked`, feedback callbacks, editor «Надіслати мені» (§24).
7. Limits, waitlist, analytics (§28–§29).

The product principle stays: **never ask for sources before Zmistik has done any work.**
