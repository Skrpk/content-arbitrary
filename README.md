# content-arbitrary

Mirrors new **photos and videos** from one X (Twitter) account into a **Telegram channel**.
Runs as a scheduled job on Vercel: every hour it checks the account, finds posts with media
it has not seen before, and republishes them to your channel.

Deploy once, add the bot to your channel, point it at an X account — after that it runs
unattended.

```
X account ──► /api/cron/sync ──► media download ──► Telegram Bot API ──► your channel
                    │
                    └── PostgreSQL (what has been published, where the cursor is)
```

---

## Table of contents

- [What it does](#what-it-does)
- [Before you start](#before-you-start)
- [A. Local setup](#a-local-setup)
- [B. Create an X developer app](#b-create-an-x-developer-app)
- [C. X API permissions and scopes](#c-x-api-permissions-and-scopes)
- [D. Create a Telegram bot with BotFather](#d-create-a-telegram-bot-with-botfather)
- [E. Add the bot to your channel](#e-add-the-bot-to-your-channel)
- [F. Get your TELEGRAM_CHAT_ID](#f-get-your-telegram_chat_id)
- [G. Create a PostgreSQL database](#g-create-a-postgresql-database)
- [H. Run migrations](#h-run-migrations)
- [I. Configure .env](#i-configure-env)
- [J. Test the Telegram bot by hand](#j-test-the-telegram-bot-by-hand)
- [K. Test with DRY_RUN](#k-test-with-dry_run)
- [L. Deploy to Vercel](#l-deploy-to-vercel)
- [M. Add environment variables in Vercel](#m-add-environment-variables-in-vercel)
- [N. How Vercel Cron works here](#n-how-vercel-cron-works-here)
- [O. Trigger the cron endpoint manually](#o-trigger-the-cron-endpoint-manually)
- [P. Debugging common failures](#p-debugging-common-failures)
- [Q. Telegram 429 and retry_after](#q-telegram-429-and-retry_after)
- [R. When X does not return the media you expect](#r-when-x-does-not-return-the-media-you-expect)
- [Configuration reference](#configuration-reference)
- [Architecture decisions](#architecture-decisions)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Operating notes](#operating-notes)

---

## What it does

Each run:

1. Fetches the account's recent posts (`GET /2/users/:id/tweets`), using a stored `since_id`
   cursor so it only pays for and processes what is new.
2. Keeps only posts that carry photos or videos. Reposts and replies are skipped by default,
   both configurable.
3. Processes posts **oldest first**, so a burst of posts arrives in the channel in the order
   they were written.
4. Picks the right Bot API method:
   - 1 photo → `sendPhoto`
   - 1 video → `sendVideo` (highest-bitrate MP4, `supports_streaming`)
   - 2+ items → `sendMediaGroup` (one album; photos and videos may mix)
5. Builds a clean caption: the original post text, then `Source: https://x.com/…`.
6. Records the result so the same post is never published twice.

A published message looks like this, and nothing more:

```
Four photos from the shoot

Source: https://x.com/someaccount/status/1750000000000000003
```

---

## Before you start

### Plan requirements (Vercel)

The hourly schedule in `vercel.json` requires a **Pro or Enterprise** plan, which allows
intervals down to once per minute and fires within the specified minute.

> **On Hobby**, cron jobs are limited to **once per day** and a more frequent expression fails
> the deployment. Either change the schedule to a daily one (e.g. `"schedule": "0 9 * * *"` —
> Hobby crons fire somewhere within that hour, not on the minute), or keep the hourly schedule
> and trigger `/api/cron/sync` from an external scheduler (GitHub Actions, cron-job.org,
> Upstash QStash) sending `Authorization: Bearer $CRON_SECRET`. Nothing else differs.

Pro also allows a function `maxDuration` of up to 800s. This route asks for **300s**, which is
the platform default on every plan and is far more than a run of five posts needs — there is no
reason to raise it unless you increase `MAX_POSTS_PER_RUN` a great deal.

### The X API is paid, per post read

X has moved to **pay-per-usage pricing**: you buy credits and they are drawn down per request.
Reading posts costs around **$0.005 per post**, or about **$0.001 per post when you are the
authenticated owner of the account** you are reading. There is a hard ceiling of ~3 million
post reads per billing cycle on standard accounts, and a 24-hour de-duplication window
(requesting the same resource twice in a day is billed once).

This is why the app stores a `since_id` cursor and why `X_FETCH_LIMIT` defaults to 20 rather
than 100 — an idle account costs you almost nothing per run. Check current pricing at
<https://docs.x.com/x-api/getting-started/pricing> before committing to a schedule.

---

## A. Local setup

Requirements: **Node.js 20.9+** and a PostgreSQL database.

```bash
git clone <your-repo-url>
cd content-arbitrary
npm install
cp .env.example .env
```

Fill in `.env` as you work through sections B–I, then:

```bash
npm run db:migrate     # create the tables
npm run telegram:check # verify the bot can post to your channel
npm run sync:local     # run one cycle (DRY_RUN=true by default)
```

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Next dev server (the cron route is not scheduled locally) |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Full test suite |
| `npm run db:generate` | Regenerate migrations after editing `src/db/schema.ts` |
| `npm run db:studio` | Drizzle Studio, to browse the tables |
| `npm run sync:local` | Run one sync cycle from the CLI |
| `npm run telegram:check` | Four-step Telegram configuration check |

---

## B. Create an X developer app

1. Go to <https://developer.x.com/en/portal/dashboard> and sign in.
2. Create a **Project**, then an **App** inside it.
3. Open the app's **Keys and tokens** tab.
4. Under **Authentication Tokens**, generate the **Bearer Token**.
5. Copy it into `X_BEARER_TOKEN`. It is shown once — regenerate it if you lose it.

Then set the account you want to mirror:

- `X_USERNAME=someaccount` (without the `@`), and ideally
- `X_USER_ID=1234567890` — the numeric id.

**Set `X_USER_ID` if you can.** Without it, every run spends an extra API call resolving the
handle. To find it once:

```bash
curl -s "https://api.x.com/2/users/by/username/someaccount" \
  -H "Authorization: Bearer $X_BEARER_TOKEN"
```

## C. X API permissions and scopes

This app only reads, so an **app-only Bearer token** is enough — no OAuth user flow.

- Endpoint: `GET /2/users/:id/tweets`
- Scopes (if you use OAuth 2.0 instead): `tweet.read`, `users.read`
- App permission: **Read** is sufficient

The account you mirror must be **public**. This project deliberately does not attempt to read
protected or private accounts, bypass access controls, or strip watermarks — use it for
content you own or have permission to republish.

## D. Create a Telegram bot with BotFather

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a display name (e.g. `My Mirror Bot`).
4. Choose a username ending in `bot` (e.g. `my_mirror_bot`).
5. BotFather replies with a token like `123456789:AAH...`. That is `TELEGRAM_BOT_TOKEN`.

Treat the token like a password: anyone holding it controls the bot. If it leaks, send
`/revoke` to BotFather.

## E. Add the bot to your channel

The bot must be an **administrator** with permission to post.

1. Open your channel → **Manage Channel** → **Administrators** → **Add Administrator**.
2. Search for your bot by its `@username` and select it.
3. Enable **Post Messages** (the only permission this app needs).
   You may leave Edit/Delete/Pin off.
4. Save.

A bot that is merely a *member* of a channel cannot post; Telegram returns
`not enough rights to send photos to the chat`.

## F. Get your TELEGRAM_CHAT_ID

`TELEGRAM_CHAT_ID` accepts either form:

- **Numeric id**, e.g. `-1001234567890` — works for public *and* private channels. **Preferred.**
- **`@channelusername`** — public channels only.

Easiest reliable method — post anything to the channel, then:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | grep -o '"chat":{"id":[^,]*'
```

Or, if the channel is public:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=@yourchannel"
```

The `id` in the response (a negative number beginning `-100`) is your chat id.
`npm run telegram:check` also prints it.

## G. Create a PostgreSQL database

Any PostgreSQL works. Two easy options:

**Neon** (<https://neon.tech>) — create a project and copy the **pooled** connection string.

**Vercel Postgres** — in your Vercel project: **Storage → Create Database → Postgres**.
Vercel injects `POSTGRES_URL`; copy its value into `DATABASE_URL` (or add `DATABASE_URL`
pointing at the same value).

Use the **pooled** endpoint. Serverless functions open many short-lived connections and will
exhaust a direct connection limit.

## H. Run migrations

```bash
npm run db:migrate
```

This creates three tables:

| Table | Purpose |
| --- | --- |
| `processed_posts` | One row per X post ever seen. `x_post_id` is **UNIQUE** — the guarantee against double-posting. |
| `telegram_messages` | Every Telegram message id produced, including each item of an album. |
| `sync_state` | The `since_id` cursor and last-run health per source. |

If you change `src/db/schema.ts`, run `npm run db:generate` to create a new migration, then
`npm run db:migrate` to apply it. Migrations are idempotent and safe to re-run.

## I. Configure .env

Copy `.env.example` to `.env` and fill it in. Minimum viable configuration:

```bash
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

X_USER_ID=1234567890
X_USERNAME=someaccount
X_BEARER_TOKEN=AAAAAAAAAAAA...

TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_CHAT_ID=-1001234567890

CRON_SECRET=<at least 16 random characters>

DRY_RUN=true
```

Generate a secret with:

```bash
openssl rand -base64 32
```

Configuration is validated with Zod at startup. A missing or malformed variable fails
immediately with a message naming the variable, rather than failing halfway through a publish.

`.env` is gitignored. Never commit real credentials.

## J. Test the Telegram bot by hand

The built-in check runs four steps and tells you exactly which one fails:

```bash
npm run telegram:check
```

```
[1/4] Bot token is valid: @my_mirror_bot
[2/4] Chat resolved: My Channel (type: channel, id: -1001234567890)
[3/4] Bot status in chat: administrator
[4/4] Test message delivered. message_id=42
All checks passed.
```

To do the same by hand:

```bash
# 1. Is the token valid?
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"

# 2. Can the bot see the channel?
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=$TELEGRAM_CHAT_ID"

# 3. Can it post text?
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
  -d chat_id="$TELEGRAM_CHAT_ID" -d text="hello from content-arbitrary"

# 4. Can it post a photo?
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendPhoto" \
  -d chat_id="$TELEGRAM_CHAT_ID" \
  -d photo="https://telegram.org/img/t_logo.png" -d caption="test"
```

Do this **before** enabling the cron. Almost every "it silently does nothing" report is a bot
that is not an admin of the channel.

## K. Test with DRY_RUN

`DRY_RUN=true` (the default) does everything except publish: it reads X, filters posts,
extracts media, builds the caption and decides which Bot API method it would call.

```bash
npm run sync:local
```

```
DRY RUN:
X Post: 1750000000000000003
Media: 4 photos
Telegram method: sendMediaGroup
Caption: "Four photos from the shoot\n\nSource: https://x.com/someaccount/status/1750000000000000003"
Would publish: true
```

Posts previewed in a dry run are stored as `pending` and the cursor is **not** advanced, so
the first real run publishes exactly what you previewed.

When the output looks right, set `DRY_RUN=false` and run it again for real.

## L. Deploy to Vercel

```bash
npm i -g vercel
vercel            # link the project
vercel --prod     # deploy
```

Or push to GitHub and import the repository at <https://vercel.com/new>.

`vercel.json` already declares the schedule:

```json
{
  "crons": [{ "path": "/api/cron/sync", "schedule": "0 * * * *" }]
}
```

After the first production deploy, confirm the job appears under
**Project → Settings → Cron Jobs**. Cron jobs only run from **production** deployments.

## M. Add environment variables in Vercel

**Project → Settings → Environment Variables.** Add every variable from your `.env` for the
**Production** environment:

`DATABASE_URL`, `X_USER_ID`, `X_USERNAME`, `X_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `CRON_SECRET`, plus any optional ones you use.

Two things to get right:

- **`CRON_SECRET` must be set on the Vercel project.** Vercel reads it and automatically sends
  `Authorization: Bearer $CRON_SECRET` when it invokes your cron. It is not just your own check.
- **Start with `DRY_RUN=true` in production too.** Watch one real cron run in the logs, confirm
  it found what you expect, then set `DRY_RUN=false` and redeploy.

Changing environment variables requires a redeploy to take effect.

## N. How Vercel Cron works here

- Vercel sends an HTTP **GET** to `/api/cron/sync` on your **production** deployment.
- The request carries `Authorization: Bearer $CRON_SECRET`, plus
  `user-agent: vercel-cron/1.0` and an `x-vercel-cron-schedule` header.
- Expressions are standard 5-field cron (minute, hour, day-of-month, month, day-of-week),
  **always in UTC**. Names like `MON` or `JAN` are not supported, and you cannot set both
  day-of-month and day-of-week.
- **Vercel does not retry a failed invocation.** That is fine here: an unpublished post stays
  `pending`/`failed` in the database and the next hourly run picks it up.
- Delivery is best effort. A run can be missed, or occasionally delivered twice — which is
  exactly why the sync is idempotent (see [Architecture decisions](#architecture-decisions)).

On **Pro/Enterprise** the job fires within the specified minute, so `0 * * * *` means the top
of each hour. (Hobby spreads invocations across the hour.)

The route sets `maxDuration = 300`, the platform default. Pro allows up to 800s if you ever
need it, but a five-post run finishes in seconds.

## O. Trigger the cron endpoint manually

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-project>.vercel.app/api/cron/sync" | jq
```

```json
{
  "checked": 12,
  "newPosts": 2,
  "published": 2,
  "failed": 0,
  "skipped": 10,
  "dryRun": false,
  "durationMs": 3242,
  "runId": "282d68d5"
}
```

For convenience during setup, the secret may also be passed as a query parameter
(`?secret=…`). Prefer the header where you can — URLs end up in logs.

The admin endpoint shows recent history and never returns secrets:

```bash
curl -s -H "Authorization: Bearer $ADMIN_SECRET" \
  "https://<your-project>.vercel.app/api/status" | jq
```

It reports the last successful sync, the last error, counts by status, and the ten most
recently processed posts with their Telegram message ids. It is protected by `ADMIN_SECRET`,
falling back to `CRON_SECRET` if you do not set one.

## P. Debugging common failures

Logs are structured JSON, one object per line, each tagged with the `runId` of its sync.
Filter a run in Vercel's log viewer by that id. Secrets are scrubbed before anything is written.

| Symptom | Cause and fix |
| --- | --- |
| `401 Unauthorized` from the cron | `CRON_SECRET` missing in Vercel, or differs from what you sent. It must be ≥ 16 characters. |
| `chat not found` | Wrong `TELEGRAM_CHAT_ID`, or the bot was never added to the channel. Run `npm run telegram:check`. |
| `not enough rights to send photos to the chat` | The bot is a member but not an **administrator**, or lacks **Post Messages**. |
| `Could not resolve @handle` | Handle is misspelled, or the account is suspended/protected. |
| X API `401` | Bad or revoked `X_BEARER_TOKEN`. |
| X API `403` | Your access tier does not permit this endpoint, or the account is protected. |
| X API `429` | Rate limited. The client honours `x-rate-limit-reset` and backs off; if it persists, lower `X_FETCH_LIMIT` or the frequency. |
| `checked: 0` every run | The cursor has advanced past everything — normal when there is nothing new. Confirm with `/api/status` → `lastSeenPostId`. |
| Posts found, none published | Almost always `DRY_RUN=true`. Check `dryRun` in the response. |
| `file is too big` | Over Telegram's upload limit; the post is marked `skipped` with the reason. See §R. |
| Nothing runs at all | Cron jobs only run on **production** deployments — and on Hobby, only once per day. |
| Run seems stuck | Check `/api/status` for a `processing` row. A killed function's row is reclaimed automatically after 10 minutes. |

To inspect a specific post's fate, look it up in `processed_posts`: `status`, `error_message`
and `retry_count` explain what happened.

## Q. Telegram 429 and retry_after

Telegram returns HTTP 429 with `parameters.retry_after` (seconds) when you exceed flood limits.
The client **obeys that value exactly** rather than applying its own backoff:

```json
{"event":"telegram.rate_limited","method":"sendVideo","retryAfterSeconds":2}
{"event":"retry.scheduled","label":"telegram:sendVideo","delayMs":2000,"honouredRetryAfter":true}
```

Guardrails:

- Waits at most **120 seconds** for a single flood wait. Anything longer is abandoned and left
  for the next cron run instead of holding the function open.
- Paces sends **~1.1 s apart**, matching the Bot FAQ's guidance of no more than one message per
  second in a single chat (and 20 messages per minute in a group).
- Other transient failures (5xx, network) use exponential backoff **with jitter**, up to
  `MAX_RETRY_ATTEMPTS` (default 5).

If you see sustained 429s, lower `MAX_POSTS_PER_RUN`. An album counts as one send, so a
backlog of single posts is what actually pushes you into flood control.

## R. When X does not return the media you expect

**Why media is downloaded and re-uploaded, rather than handed to Telegram as a URL.**
Telegram can fetch a URL itself, but that path caps at **5 MB for photos and 20 MB for other
files**, and depends on Telegram's servers reaching the X CDN. Downloading and uploading the
bytes as `multipart/form-data` raises the ceiling to **10 MB for photos and 50 MB for other
files** and removes that dependency, so it is the default (`MEDIA_UPLOAD_MODE=multipart`).
Set `MEDIA_UPLOAD_MODE=url` if you prefer the cheaper path and your media is small.

Nothing is written to disk — the local filesystem does not survive between invocations.
Assets are streamed with a running size check and the transfer is **aborted** as soon as it
exceeds what Telegram would accept, so an oversized video is never pulled into memory.

Known situations and how they are handled:

| Situation | Behaviour |
| --- | --- |
| Video has only an HLS (`.m3u8`) variant | `skipped`, reason `no progressive MP4 variant`. Telegram cannot ingest a playlist. |
| Best MP4 rendition is over the budget | The next-best rendition that fits is sent instead (see below). |
| Every MP4 rendition is over the budget | `skipped`, naming the smallest size found. |
| Photo larger than 10 MB | `skipped` with the size. |
| Photo where width + height > 10000, or aspect ratio > 20 | `skipped` **before** uploading — X gives us the dimensions, so no bandwidth is wasted. |
| Post has more than 10 media items | First 10 are published as an album (Telegram's limit); a warning is logged. |
| Media missing from `includes.media` | Logged; the post is skipped if nothing usable remains. |
| One item of a multi-photo post fails | **The whole post fails and nothing is published.** |

That last rule is deliberate. A partially-published album cannot be repaired by a retry — the
retry would duplicate whatever did get through. So every asset is downloaded and validated
*before* the first Bot API call: a post either appears complete or does not appear at all, with
the reason recorded.

### Choosing a video rendition

X encodes every video at several bitrates (commonly three: roughly 320p, 480p and 720p/1080p)
and lists them all in `media.variants`. Rather than always taking the largest and giving up
when it is over the limit, the publisher picks **the highest-bitrate MP4 that actually fits**:

1. keep only `video/mp4` variants — HLS playlists cannot be uploaded to Telegram;
2. sort by bitrate, highest first;
3. ask the CDN for each candidate's size (`HEAD` → `Content-Length`, falling back to a
   one-byte range request reading `Content-Range`, and to a bitrate × duration estimate if the
   CDN reports neither);
4. send the first one within `min(MAX_VIDEO_SIZE_MB, Telegram's 50 MB)`;
5. only if none fit is the post `skipped`, with the smallest size in the reason.

Probing runs highest-first and stops at the first fit, so the common case costs a single `HEAD`
request, and an oversized rendition is never downloaded. A video with a single variant skips
probing entirely.

This is why the project needs no transcoding: X has already produced the smaller encodes, so
FFmpeg would only duplicate work that a size-aware choice does for free.

`supports_streaming` plus width/height/duration are always passed so Telegram renders a
seekable player.

---

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string (use the pooled endpoint). |
| `X_USER_ID` | — | Numeric X user id. Strongly recommended: saves a billed API call per run. |
| `X_USERNAME` | — | X handle. Required if `X_USER_ID` is unset; also used for source links. |
| `X_BEARER_TOKEN` | — | **Required.** App-only Bearer token. |
| `X_API_BASE_URL` | `https://api.x.com` | Override only if proxying. |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** From BotFather. |
| `TELEGRAM_CHAT_ID` | — | **Required.** `-1001234567890` or `@channelusername`. |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Override for a local Bot API server. |
| `TELEGRAM_DISABLE_NOTIFICATION` | `false` | Post silently. |
| `CRON_SECRET` | — | **Required, ≥ 16 chars.** Protects `/api/cron/sync`. |
| `ADMIN_SECRET` | falls back to `CRON_SECRET` | Protects `/api/status`. |
| `CAPTION_PREFIX` | empty | Text prepended, separated by a blank line. |
| `CAPTION_SUFFIX` | empty | Text appended, separated by a blank line. |
| `INCLUDE_SOURCE_LINK` | `true` | Append `Source: https://x.com/…`. |
| `INCLUDE_REPLIES` | `false` | Publish replies. |
| `INCLUDE_REPOSTS` | `false` | Publish reposts/retweets. |
| `INCLUDE_QUOTES` | `true` | Publish quote posts that carry their own media. |
| `MAX_POSTS_PER_RUN` | `5` | Posts published per run. Keeps you inside Telegram's rate limits. |
| `X_FETCH_LIMIT` | `20` | Posts requested from X per run (API allows 5–100). Must be ≥ `MAX_POSTS_PER_RUN`. |
| `MAX_RETRY_ATTEMPTS` | `5` | Attempts per transient failure, including the first. |
| `MEDIA_UPLOAD_MODE` | `multipart` | `multipart` (higher limits) or `url` (cheaper). |
| `MAX_VIDEO_SIZE_MB` | `50` | Largest video to send (1–50). A video above this budget is sent at the best lower X rendition that fits. |
| `DRY_RUN` | `true` | Do everything except publish. |

Booleans accept `true/false`, `1/0`, `yes/no`, `on/off`.

### Verified API limits

These are read from the official documentation and live in
[`src/lib/telegram/limits.ts`](src/lib/telegram/limits.ts) as the single source of truth:

| Limit | Value |
| --- | --- |
| Caption length | 1024 characters |
| Message text length | 4096 characters |
| Album size | 2–10 items (photos and videos may be mixed) |
| Upload via multipart | 10 MB photo / 50 MB other |
| Upload via URL | 5 MB photo / 20 MB other |
| Photo dimensions | width + height ≤ 10000, ratio ≤ 20 |

---

## Architecture decisions

**Drizzle ORM, not Prisma.** Prisma ships a query-engine binary that inflates the serverless
bundle and cold-start time. Drizzle is plain TypeScript with generated SQL migrations.

**postgres.js, not the Neon HTTP driver.** The HTTP driver cannot do interactive transactions
or session-level advisory locks, and this design needs both. postgres.js works unchanged
against Neon, Vercel Postgres, Supabase or self-hosted PostgreSQL.
The pool is capped at 2 connections: the advisory lock reserves one for the run's duration,
and the second serves queries. (With a pool of 1, the lock starves every subsequent query and
the run deadlocks — there is a regression test for exactly this.)

**HTML parse mode, not MarkdownV2.** MarkdownV2 requires escaping 18 characters wherever they
appear, and one missed character makes Telegram reject the entire message with
`can't parse entities`. HTML needs three (`&`, `<`, `>`), which is far safer on arbitrary
author-written text.

**Idempotency in three layers.** Vercel documents that cron delivery can duplicate an
invocation and that a long run may overlap the next one, so duplicate protection cannot rely
on scheduling:

1. A **PostgreSQL advisory lock** means only one sync runs at a time; an overlapping
   invocation exits immediately with `lockBusy` rather than queueing.
2. An **atomic claim** — a single `INSERT … ON CONFLICT DO UPDATE … WHERE` against the UNIQUE
   `x_post_id` — decides ownership of each post in one statement. Ten simultaneous runners
   produce exactly one winner. This is the guarantee that actually prevents double-posting;
   the lock is only an optimisation.
3. A **processing lease**: a row claimed by a function that was then killed is reclaimed after
   10 minutes, so a crash cannot strand a post forever.

**The cursor only advances when nothing failed.** Moving `since_id` past a failed post would
hide it from every future run.

**Unicode-safe truncation.** Captions are cut on grapheme boundaries via `Intl.Segmenter`, so
an emoji, flag or ZWJ sequence is never split into replacement characters. The X API's entity
offsets are in code points while JavaScript strings are UTF-16, so t.co links are removed by
matching the literal URL rather than slicing by offset — slicing corrupts any post containing
emoji.

**Link handling.** t.co links are replaced with the author's real `expanded_url`. The trailing
`pic.x.com/…` link X appends for a post's own media is removed entirely, since the media is
attached to the Telegram message. Links the author genuinely wrote are preserved.

---

## Project structure

```
src/
  app/
    api/cron/sync/route.ts     GET /api/cron/sync   — CRON_SECRET protected
    api/status/route.ts        GET /api/status      — ADMIN_SECRET protected
  db/
    schema.ts                  Drizzle tables
    migrations/                Generated SQL
  lib/
    env.ts                     Zod-validated configuration + redacted summary
    db.ts                      Pooled connection
    auth.ts                    Constant-time secret comparison
    errors.ts                  Transient vs permanent taxonomy
    logger.ts                  Structured JSON logs with secret scrubbing
    x/
      client.ts                X API v2 transport
      schemas.ts               Zod models of X responses
      get-new-posts.ts         Fetch, filter, order oldest-first
      normalize-post.ts        Text cleanup, t.co handling, video variant choice
      download-media.ts        Size-guarded streaming download
    telegram/
      client.ts                Bot API transport, 429 / retry_after
      limits.ts                Documented limits, single source of truth
      format-caption.ts        Caption assembly, HTML escaping, safe truncation
      send-media.ts            sendPhoto / sendVideo / sendMediaGroup / sendMessage
    sync/
      sync-posts.ts            Orchestration
      process-post.ts          Per-post publish, all-or-nothing media policy
      repository.ts            Atomic claim and state transitions
      locks.ts                 Advisory lock
      retry.ts                 Backoff with jitter
scripts/                       migrate, run-sync, telegram-check
tests/                         Unit + integration suites
```

---

## Testing

```bash
npm test
```

208 tests. The unit suite runs anywhere. The integration suites need a real PostgreSQL,
because the guarantees under test — UNIQUE races, `ON CONFLICT` semantics, advisory locks —
only exist in the database; they are **skipped** rather than failed when no database is
configured.

```bash
docker run -d --name ca-test-pg \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=content_arbitrary_test \
  -p 55432:5432 postgres:16-alpine

DATABASE_URL=postgresql://postgres:test@localhost:55432/content_arbitrary_test \
  npm run db:migrate

TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/content_arbitrary_test \
  npm test
```

Coverage includes caption building and Unicode-safe truncation; t.co media-link removal;
source links; reply/repost/quote filtering; oldest-first ordering; method selection
(1 photo → `sendPhoto`, 1 video → `sendVideo`, many → `sendMediaGroup`); album caption
placement; retry and backoff; Telegram 429 `retry_after`; X and Telegram response parsing;
media size guards; duplicate prevention under ten concurrent claims; two concurrent syncs
publishing each post exactly once; and the pool-starvation deadlock regression.

---

## Operating notes

- **Watch the first real run.** Set `DRY_RUN=false`, trigger `/api/cron/sync` by hand, and
  check the channel before trusting the schedule.
- **Backfill is intentionally limited.** On first run the app publishes at most
  `MAX_POSTS_PER_RUN` posts from the last `X_FETCH_LIMIT`, not the account's whole history.
  To skip the backlog entirely, set `sync_state.last_seen_post_id` to the newest post id before
  the first live run.
- **The channel is append-only.** Deleting a Telegram message does not change the database; the
  post stays `published` and will not be re-sent. Delete its `processed_posts` row to republish.
- **`npm audit`** reports moderate advisories from `drizzle-kit`'s bundled esbuild. These are
  dev-only tooling and are not part of the deployed function.

## Licence

Provided as-is. You are responsible for complying with the X Developer Agreement, Telegram's
Terms of Service, and the copyright of anything you republish.
