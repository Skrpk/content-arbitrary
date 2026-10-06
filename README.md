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
- [Multiple channels](#multiple-channels)
- [Shadow Radar](#shadow-radar)
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
2. Keeps only posts that carry photos or videos — or, for a source with **Posts without
   media** switched on, text-only posts too. Reposts and replies are skipped by default, both
   configurable.
3. Processes posts **oldest first**, so a burst of posts arrives in the channel in the order
   they were written.
4. Picks the right Bot API method:
   - 1 photo → `sendPhoto`
   - 1 video → `sendVideo` (highest-bitrate MP4, `supports_streaming`)
   - 2+ items → `sendMediaGroup` (one album; photos and videos may mix)
   - no media (text-only posts, when enabled for the source) → `sendMessage`
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

The schedules in `vercel.json` — the hourly sync and the every-minute publisher for
[scheduled posts](#scheduling-a-post) — require a **Pro or Enterprise** plan, which allows
intervals down to once per minute and fires within the specified minute.

> **On Hobby**, cron jobs are limited to **once per day** and a more frequent expression fails
> the deployment. Either change the schedule to a daily one (e.g. `"schedule": "0 9 * * *"` —
> Hobby crons fire somewhere within that hour, not on the minute), or keep the hourly schedule
> and trigger `/api/cron/sync` from an external scheduler (GitHub Actions, cron-job.org,
> Upstash QStash) sending `Authorization: Bearer $CRON_SECRET`. The same goes for
> `/api/cron/publish-scheduled`, which needs to run every minute. Nothing else differs.

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
| `npm run webhook:set -- <url>` | Register the approval webhook |
| `npm run webhook:info` | Show the registered webhook and last delivery error |
| `npm run webhook:delete` | Remove the webhook |

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
| `workspaces` | The tenant a channel and its sources belong to. One row today, seeded from the environment. |
| `sources` | Accounts being watched. `(workspace_id, platform, external_id)` is **UNIQUE**, so the same account cannot be added twice. |
| `processed_posts` | One row per X post ever seen. `(workspace_id, x_post_id)` is **UNIQUE** — the guarantee against double-posting. |
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

`DATABASE_URL`, `X_BEARER_TOKEN`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, plus any optional ones you
use. On a fresh install, `TELEGRAM_CHAT_ID` (and `TELEGRAM_ADMIN_CHAT_ID` with approval on) set
up the first channel; once that is in the database they can be removed.

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
| Best MP4 rendition is over the preferred budget | The best rendition that meets the budget is sent; if none does, the original is sent anyway. |
| Every MP4 rendition is over the hard ceiling | `skipped`, naming the smallest size found. |
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
4. send the best rendition at or under `PREFERRED_VIDEO_SIZE_MB`, if one exists;
5. if none qualifies, send the best rendition within the hard ceiling
   `min(MAX_VIDEO_SIZE_MB, Telegram's 50 MB)` — a large original beats a dropped post;
6. only if nothing fits the hard ceiling is the post `skipped`, with the smallest size named.

Setting `PREFERRED_VIDEO_SIZE_MB=10` therefore means "send a version under 10 MB when X offers
one, otherwise post the original anyway". Leaving it unset always sends the best quality that
fits.

Probing runs highest-first and stops at the first fit, so the common case costs a single `HEAD`
request, and an oversized rendition is never downloaded. A video with a single variant skips
probing entirely.

This is why the project needs no transcoding: X has already produced the smaller encodes, so
FFmpeg would only duplicate work that a size-aware choice does for free.

`supports_streaming` plus width/height/duration are always passed so Telegram renders a
seekable player.

---

## Managing sources

Accounts to watch live in the database and are managed from the bot's private chat — no
environment change and no redeploy:

| Command | What it does |
| --- | --- |
| `/sources` | List every source and whether it is active |
| `/addsource @karpathy` | Start watching an account |
| `/removesource @karpathy` | Stop watching and forget it |
| `/pausesource @karpathy` | Keep it on the list but skip it on sync |
| `/resumesource @karpathy` | Watch it again |

`/addsource` accepts whatever is easiest to paste — `karpathy`, `@karpathy`,
`x.com/karpathy`, a full profile URL, or even a link to one of the account's posts.

Only a workspace's reviewer may run these, for the workspaces that name them; anyone else is
ignored without a reply.
The commands arrive over the same webhook as the Approve buttons, so
`npm run webhook:set` must have been run once (see below).

### Per-source settings

With `APP_BASE_URL` set, the replies to `/sources` and `/addsource` carry a **⚙️ Settings**
button. It opens a Mini App listing your sources, each with its own switches, saved as soon as
they are flipped:

| Setting | Default | What it does |
| --- | --- | --- |
| Active | on | Off is the same as `/pausesource`. |
| Posts without media | off | Also mirror the account's text-only posts, as text messages (`sendMessage`, up to 4096 characters, with the same prefix, source link and suffix as a caption). |

A new source mirrors media posts only, as every source always has. Turning **Posts without
media** on applies to posts that arrive from then on — ones the cursor has already passed are
not fetched again. A post whose media exists but cannot be sent (an HLS-only video, say) is
still skipped rather than published as bare text, which would misrepresent it.

Text-only posts go through review exactly like the rest: the preview is the message itself,
Edit allows up to 4096 characters, and Approve sends it to the channel. X already returns
these posts in the timeline we pay for, so mirroring them costs nothing extra on the X side.

### How sources are identified

The numeric X user id is the identity, not the handle. Handles get renamed and reused, so
matching on one would eventually follow the wrong account; the id never changes. A rename is
noticed on the next sync and the cached handle is updated in passing.

Each source keeps its own cursor (`sync_state`, keyed `x:<userId>`), so accounts never
interfere with one another: adding a busy account cannot starve a quiet one, and one
unreachable account does not stop the rest of the run — its error is reported per source while
the others carry on. `MAX_POSTS_PER_RUN` applies **per source** for the same reason.

Removing a source deliberately leaves its cursor behind, so re-adding the same account later
resumes where it stopped instead of re-reading — and re-paying for — the whole window.

### Upgrading from the single-account version

Nothing to do. On the first run with an empty source list, `X_USER_ID` / `X_USERNAME` are
imported into the `sources` table and everything continues as before, resuming from the cursor
the single-account version left behind rather than re-reading (and re-paying for) the window.

The import happens once, recorded as `workspaces.legacy_source_imported_at`, so a source you
deliberately remove does not reappear on the next run. Keep the two variables until you have
seen the source appear in `/sources`; after that they are ignored and can be deleted. New
installations should leave them blank and use `/addsource`.

## Multiple channels

One installation can serve several channels. A **workspace** is one of them: a destination
channel, the reviewer who approves for it, and its own list of sources. Everything else — the
bot token, the X application, and the tuning in [Configuration reference](#configuration-reference)
— is shared by all of them.

Because every workspace uses the same X application, two workspaces watching the same account
each keep their own cursor and are therefore **billed separately** for reading it. One account
mirrored into three channels costs three times one channel.

### Adding a workspace

There is no command for this: creating a tenant is an operator action, not something a reviewer
should be able to do from a chat. Insert the row directly.

```sql
INSERT INTO workspaces (name, telegram_chat_id, telegram_admin_chat_id)
VALUES ('second channel', '-1001234567890', '123456789');
```

- `telegram_chat_id` — the channel, found exactly as in [F](#f-get-your-telegram_chat_id). Add
  the bot to it as an administrator with **Post messages** first.
- `telegram_admin_chat_id` — the reviewer's numeric Telegram user id. This is also what
  authorises them: they can run `/addsource` and press Approve for the workspaces that name
  them, and no others. Note that a channel id is negative and begins `-100`, while a user id is
  positive.
- `name` — shown to a reviewer of more than one channel, so give it the channel's name.

#### One reviewer for several channels

The same person may be the reviewer of any number of workspaces — use the same
`telegram_admin_chat_id` in each row. Then:

- every button and Mini App acts on the post's own channel, whichever it is: the post decides
  the workspace, and the reviewer only has to be its reviewer;
- review messages start with `📢 <name>`, so the two channels' posts can be told apart;
- `/addsource` asks which channel with a button per channel; `/removesource`, `/pausesource`
  and `/resumesource` act at once when only one channel watches the account, and ask when
  several do;
- `/sources`, `/scheduled` and the ⚙️ Settings page cover every channel, grouped by name.

A reviewer of a single channel sees none of this — no labels, no questions.

The reviewer must have sent the bot a message at least once before the first post is held for
them: Telegram does not allow a bot to open a conversation, so review would otherwise fail with
`403 bot can't initiate conversation with a user`. Their `/start` also reveals their user id —
it is logged as the `fromId` of `webhook.unauthorized_command`.

`legacy_source_imported_at` needs no value. The environment account is imported for workspace 1
only, and the guard for that is the workspace id check in `syncPosts`, not this column.

The reviewer then adds sources from their own chat with the bot:

```
/addsource @someaccount
```

Nothing else is needed; the next cron run picks the workspace up. A workspace with no
`telegram_chat_id` is skipped as still being set up, and so is one with no reviewer while
`REQUIRE_APPROVAL=true` — publishing unreviewed would defeat the point. `/api/status` lists
every workspace with a `publishable` flag and the reason when it is false.

`TELEGRAM_CHAT_ID` and `TELEGRAM_ADMIN_CHAT_ID` **seed workspace 1 only**, and only while its
columns are still empty. Once a workspace row has a destination, the row wins: repoint a channel
in the database and the environment will not overwrite it on the next run.

### Pausing or removing a workspace

To park a workspace without losing anything, clear its destination. The sync skips it as
still being set up, and its sources, cursors and history stay exactly as they are:

```sql
UPDATE workspaces SET telegram_chat_id = NULL WHERE id = 2;
```

Deleting the row is destructive. `ON DELETE CASCADE` takes its sources, its cursors **and its
entire publishing history** (`processed_posts`, and the `telegram_messages` hanging off them)
with it:

```sql
DELETE FROM workspaces WHERE id = 2;
```

Losing that history also loses the duplicate protection built on it: re-create the workspace
with the same sources and, because the cursors are gone too, the next run reads the window from
scratch and re-publishes posts the channel has already seen. Prefer clearing the destination
unless you genuinely want the tenant forgotten.

## Approval before publishing

With `REQUIRE_APPROVAL=true` nothing reaches the channel unattended. Each new post is
delivered to your private chat with the bot, carrying **✅ Approve** and **🚫 Reject** buttons;
the channel only sees it once you press Approve.

```
X ──► cron ──► your private chat  ──[Approve]──►  channel
                      │
                      └──[Reject]──► pick a reason ──►  recorded, never published
```

Reject does not settle the post by itself: it swaps the buttons for a short list of reasons —
*Not interesting*, *Off-topic*, *Already covered*, *Too minor*, *Weak source*, *Other* — and the
post is rejected when you pick one. **↩️ Back** returns to Approve / Reject if Reject was a
misclick. The reason is stored in `processed_posts.rejection_reason` under a stable value
(`not_interesting`, `wrong_topic`, `already_covered`, `too_minor`, `weak_source`, `other`);
the button wording may change, those values do not.

With `APP_BASE_URL` set, **••• Other** opens a small Mini App where you can say why in your own
words; the post is rejected when you press Reject there, and the text is kept in
`rejection_note`. Closing it without pressing Reject changes nothing. Without `APP_BASE_URL`,
Other rejects straight away like the other reasons.

What is recorded for every post, for later analysis:

| Column | Holds |
|---|---|
| `source_text` | The author's whole text as X gave it — the full text of a long-form post, links resolved, plain text, before any prefix, suffix, source link or truncation. Written when the post is first seen, whatever happens to it next. |
| `original_caption` / `caption` | The caption first sent for review, and the one published (they differ only after an edit). For a post published with no review, both hold what went out. |
| `caption_edited_at` | When the caption was last saved in the editor. |
| `reviewed_at` | When you pressed Approve or chose a reject reason; empty for posts published with no review. |
| `rejection_reason` / `rejection_note` | Why it was rejected, and your own words for Other. |
| `review_media` | The media you were shown — Telegram's file id per item, with X's photo URL or video still. Kept after the decision (unlike `approval_payload`), so Radar's backfill can show a model the same picture. |
| `x_like_count`, `x_repost_count`, `x_reply_count`, `x_quote_count`, `x_bookmark_count`, `x_impression_count` / `x_metrics_at` | The post's public engagement as X reported it when the post was first fetched, and when that was. A snapshot, never refreshed: compare posts by their age at that moment (`x_metrics_at - x_created_at`), since a sync sees most posts within the hour. Comes with the same read, so it costs nothing extra. |

### How it works

Inline buttons arrive over a **webhook**, which a cron-only app cannot otherwise receive, so
this adds `POST /api/telegram/webhook`. Two independent checks guard it:

1. the `X-Telegram-Bot-Api-Secret-Token` header must match `TELEGRAM_WEBHOOK_SECRET`, proving
   the call came from Telegram;
2. the pressing user must be the reviewer of the post's workspace — forwarding the message to
   someone else does not hand them the publish button.

The review send is not wasted work. Telegram returns a `file_id` for every asset it stored, and
re-sending by `file_id` needs no upload and no download. Approving therefore costs a single
cheap API call and never touches the X CDN again — which also means approving hours later still
works, long after the X media URLs have rotated.

A double tap is safe: the decision is taken by one conditional `UPDATE`, so ten simultaneous
presses produce exactly one publish. If publishing fails, the post returns to the queue with
the reason attached and Approve can simply be pressed again.

Albums cannot carry an inline keyboard, so for `sendMediaGroup` the buttons arrive on a short
reply underneath the album.

### Setting it up

1. **Send `/start` to your bot** in a private chat. Telegram forbids a bot from messaging a user
   who has never started it, so without this the review message cannot be delivered.
2. **Find your numeric user id** — do this *before* registering the webhook, since `getUpdates`
   stops working once a webhook is active:
   ```bash
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | jq '.result[].message.from.id'
   ```
3. **Generate the webhook secret** (hex, not base64 — Telegram allows only `A-Z a-z 0-9 _ -`):
   ```bash
   openssl rand -hex 32
   ```
4. **Set the variables** in Vercel and redeploy: `REQUIRE_APPROVAL=true` and
   `TELEGRAM_WEBHOOK_SECRET`, plus `TELEGRAM_ADMIN_CHAT_ID` on a fresh install to seed workspace
   1's reviewer. Enabling approval without the webhook secret fails validation at startup; a
   workspace with no reviewer is skipped by the sync with the reason, never published
   unreviewed.
5. **Register the webhook once per deployment URL:**
   ```bash
   npm run webhook:set -- https://your-project.vercel.app
   ```
   Check it any time with `npm run webhook:info`, remove it with `npm run webhook:delete`.

Without step 5 the buttons appear but nothing happens when pressed — Telegram has nowhere to
deliver the callback.

### Editing the caption before publishing

With `APP_BASE_URL` set, the review message also carries **✏️ Edit text**, which opens a Mini
App — a small web page inside Telegram — holding the caption the post will be published with.
Save, then Approve as usual.

```
X ──► cron ──► your private chat ──[Edit]──► Mini App ──save──► caption replaced
                      │
                      └──[Approve]──►  channel, with whatever the caption now says
```

What editing does and does not touch:

- only the **text** changes; the media is left alone. Approval re-sends by `file_id`, and
  re-deriving those would mean downloading from X again;
- the caption is stored escaped, so anything that looks like markup is published as the
  characters you typed. There is no way to break Telegram's parser from the editor;
- the limit is Telegram's own 1024 characters, counted as you see them. The editor shows the
  count and refuses to save over it, and the server checks again;
- if the original post was too long for a caption, the follow-up message carrying the
  untruncated text is **dropped** on edit: a hand-written caption replaces the original rather
  than summarising it. The editor says so when that applies;
- a post that has already been published or rejected cannot be edited. Approve and Edit race
  safely — whichever lands first wins, and the other is refused;
- the text first sent for review is kept in `original_caption` and never changes, however many
  times you edit; `caption` holds the current text and is what gets published, and
  `caption_edited_at` the time of the last save. Both survive the decision, so what was
  published can always be compared with what came in.

Setup is one variable:

```
APP_BASE_URL=https://your-app.vercel.app
```

It must be HTTPS, which Telegram requires for Mini Apps, and it must be the stable production
domain rather than a per-deployment URL — the button is built when the post is queued and may
be pressed days later. Leave it unset and review works exactly as before, without the button.

A Mini App page is openly reachable; that is normal, and it is not what guards anything.
Telegram hands the page a signed `initData` string, every request carries it in an
`Authorization: tma …` header, and the server does nothing until that signature verifies
against the bot token, names a Telegram user who is some workspace's reviewer, and the post
belongs to a workspace they review for. The post id in the URL is therefore not a credential:
asking for another tenant's post returns exactly what asking for a nonexistent one returns.
Signed data older than 24 hours is refused, so a captured `initData` string does not stay
usable.

If Telegram ever refuses to open the button, set your domain under **Bot Settings** in
BotFather and try again; the inline-keyboard button type documents only the HTTPS requirement.

### Scheduling a post

With `APP_BASE_URL` set, a post in review also carries **🕒 Schedule**. It opens a Mini App with
a date and time picker — in your phone's time zone — and a few shortcuts (in an hour, tonight,
tomorrow morning). Pick a time and the post is approved for then: the review message becomes
"🕒 Scheduled for Mon 5 Oct, 18:00" with these buttons:

| Button | What it does |
| --- | --- |
| ⚡ Publish now | Publishes it immediately. |
| ↩️ Unschedule | Back to review, undecided, with Approve / Reject / Schedule again. |
| 🕒 Change time | The same picker, to move it. |
| ✏️ Edit text | Still editable until it goes out; the latest text is what is published. |

`/scheduled` lists what is waiting, soonest first, at the times you picked.

**Telegram does not let bots use a channel's own scheduled messages**, so these do not appear
in the channel's *Scheduled* list. The queue lives in the database instead, and
`GET /api/cron/publish-scheduled` — run **every minute** by Vercel Cron — publishes whatever is
due, so a post goes out within a minute of its time. Most runs find nothing and cost one
indexed query.

Publishing is the same path as Approve: the stored `file_id`s, the current caption, the full
text follow-up of a long post. Each post is claimed with a conditional `UPDATE` before it is
sent, so overlapping runs or a **Publish now** pressed in the same minute publish it exactly
once. A failed publish stays scheduled and is tried again the next minute; after
`MAX_RETRY_ATTEMPTS` failures it goes back to review with the error, and the review message
says so and offers the buttons again — rather than retrying forever.

Times are stored as exact moments (`scheduled_for`, UTC) with the zone they were picked in
(`scheduled_timezone`), used only to show them back to you. A post can be scheduled up to a
year ahead. `scheduled_for` is kept after publishing, so the planned time can be compared with
when it actually went out.

### New states

| Status | Meaning |
| --- | --- |
| `awaiting_approval` | Sent to you, waiting for a button press. Not in the channel. |
| `rejected` | You declined it. Never published, never retried, never re-synced. |
| `scheduled` | Approved for a later time; published by the scheduler when it comes. |

`/api/cron/sync` reports an `awaitingApproval` count alongside `published`, and `/api/status`
shows both statuses in its counts and recent posts.

## Shadow Radar

An experiment: can a model predict which posts the editor will publish? Radar scores each post
on its way to the reviewer and records the prediction — and does nothing else. The reviewer never
sees the score, nothing is filtered, reordered or delayed, and a Radar failure leaves the post
exactly as it would have been. Whether the scores are any good is then measured against the
decisions the editor makes on their own.

**What it sees.** The tenant's `editorial_profile` (a few lines, in the editor's words, on what the
channel publishes and what it turns down), the editor's 10 most recent approvals and 10 most recent
rejections with their reasons, the share of posts they approve, and the post: its source, text and
kind of media. Each post is scored twice when it has a picture — on the text alone and on the
text with its first photo (or a video's still) — to find out whether the image is worth paying for.

**What it records**, in `radar_evaluations`: a 0–100 score (the probability the editor publishes
it), the predicted decision and rejection reason, three sub-scores, a one-sentence reason, which
past decisions it was shown, the model and prompt version, and the tokens it cost. Failed and
skipped attempts are rows too, so coverage is visible.

**Limits.** It runs inside the sync, so it has a 20-second timeout per call and two minutes per
run; after three failures in a row it stops for that run. Posts it did not get to go to review
unscored.

**Which model.** `RADAR_PROVIDER` picks it: `openai` (the default) asks GPT-6 Luna through the
Responses API, with low reasoning effort, images at low detail, and nothing stored on OpenAI's
side; `anthropic` asks Claude Haiku 4.5. Both get the same prompt and the same schema, every
score records the model that gave it, and the report keeps models apart — so switching mid-way
compares them rather than mixing them. Luna's list price is a tenth of Haiku's.

### Turning it on

1. Add the chosen provider's key (`OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` with
   `RADAR_PROVIDER=anthropic`) to your local `.env` for the scripts below — and to Vercel only if
   you want posts scored live.
2. Run `npm run db:migrate`.
3. Write the channel's profile:

   ```sql
   UPDATE workspaces SET editorial_profile = '...' WHERE id = 2;
   ```

   Setting it back to `NULL` turns Radar off for that tenant.

### Scoring past decisions

```bash
npm run radar:backfill -- --workspace 2
```

Scores posts the editor has already decided, each with only the decisions made before it arrived —
what a live Radar would have seen — so the result measures prediction, not hindsight. Since live
scores change nothing during the experiment, this measures the same thing for less: requests go
through the provider's batch API at half price, and nothing runs while nobody is looking.

It submits the requests, waits for the batch (usually minutes, at most 24 hours) and reads the
results in. If it is interrupted while waiting, pick the batch up with `--resume <batch id>`
(the id is printed) rather than running it again, or the same posts are paid for twice;
`--no-wait` submits and stops. Re-running later scores only what is new and retries what failed;
a score already recorded is never requested or changed again.

Posts that arrived before there were five approvals and five rejections behind them are left out
(`--min-per-class N`). The picture comes from `review_media`: a photo from Telegram, falling back
to X's URL, a video's still from X. Posts decided before that column existed have none and are
scored on their text;
`--text-only` skips that, `--limit N` stops after scoring N posts (the oldest first).

A resumed batch is read with the provider it was submitted to, whatever `RADAR_PROVIDER` says now.

To keep Radar to backfills only, leave the API keys out of Vercel and set them just in your local
`.env`: without the chosen provider's key the sync never calls Radar.

### Reading the results

```bash
npm run radar:report -- --workspace 2
```

Per mode (live, backfill) and variant: how often the editor approved, the mean score of approved
and rejected posts, how well the scores separate them (AUC: 0.5 is chance, 1.0 perfect),
precision at 80, recall at 50, approval rate by score band, and — for a few thresholds — how much
review work hiding the posts below it would save and how many approved posts it would have hidden.
A live score made after the editor had already decided is not counted. Text against text-and-image
is compared on the same posts only.

Change the prompt and bump `RADAR_PROMPT_VERSION` in
[`src/lib/radar/prompt.ts`](src/lib/radar/prompt.ts): results of different prompts are reported
separately and never mixed.

## Configuration reference

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string (use the pooled endpoint). |
| `X_USER_ID` | — | **Deprecated.** Legacy single-source config, imported once then ignored. |
| `X_USERNAME` | — | **Deprecated.** Legacy single-source config, imported once then ignored. |
| `X_BEARER_TOKEN` | — | **Required.** App-only Bearer token. |
| `X_API_BASE_URL` | `https://api.x.com` | Override only if proxying. |
| `TELEGRAM_BOT_TOKEN` | — | **Required.** From BotFather. |
| `TELEGRAM_CHAT_ID` | — | Seeds workspace 1's channel (`-1001234567890` or `@channelusername`), once, while its column is empty. Unused after that; safe to remove. |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | Override for a local Bot API server. |
| `TELEGRAM_DISABLE_NOTIFICATION` | `false` | Post silently. |
| `CRON_SECRET` | — | **Required, ≥ 16 chars.** Protects `/api/cron/sync`. |
| `REQUIRE_APPROVAL` | `false` | Hold every post for review instead of publishing directly. |
| `TELEGRAM_ADMIN_CHAT_ID` | — | Seeds workspace 1's reviewer (your numeric Telegram user id), once, while its column is empty. Unused after that; safe to remove. |
| `TELEGRAM_WEBHOOK_SECRET` | — | ≥ 16 chars, `A-Z a-z 0-9 _ -` only. Required when `REQUIRE_APPROVAL` is on. |
| `APP_BASE_URL` | — | Public HTTPS origin, e.g. `https://your-app.vercel.app`. Enables the Edit button; without it review works unchanged. |
| `ADMIN_SECRET` | falls back to `CRON_SECRET` | Protects `/api/status`. |
| `RADAR_PROVIDER` | `openai` | [Shadow Radar](#shadow-radar)'s model: `openai` (GPT-6 Luna) or `anthropic` (Claude Haiku 4.5). |
| `RADAR_MODEL` | provider's default | Overrides the chosen provider's model id. |
| `OPENAI_API_KEY` | — | Needed for Radar with `RADAR_PROVIDER=openai`. Without the chosen provider's key, Radar is off. |
| `ANTHROPIC_API_KEY` | — | Needed for Radar with `RADAR_PROVIDER=anthropic`. |
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
| `MAX_VIDEO_SIZE_MB` | `50` | Hard ceiling for video (1–50). Nothing larger is sent at all. |
| `PREFERRED_VIDEO_SIZE_MB` | unset | Preferred video size (1–50). A rendition at or under it wins; if none qualifies the original is sent anyway. |
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

**Long posts.** The text comes from X's `note_tweet` field where there is one, so a long-form
post (over 280 characters) is mirrored whole rather than as X's 280-character cut. A text that
does not fit the 1024-character caption goes out as media with a shortened caption, followed
by the whole text as its own message. A text longer than even that message may be (4096) is
shortened there too, with an ellipsis; in both, only the author's text is cut — `CAPTION_PREFIX`,
the source link and `CAPTION_SUFFIX` are always kept. With approval on, the reviewer's preview
shows that follow-up message too, exactly as it will be sent, between the media and the
buttons. Editing the caption drops the follow-up, and its preview is then marked as not to be
published.

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

**Workspace scoping, ahead of multi-tenancy.** `sources` and `processed_posts` carry a
`workspace_id`, and duplicate protection is `UNIQUE (workspace_id, x_post_id)` rather than
global. Only one workspace exists and the runtime still reads the channel and reviewer from the
environment — but the columns are in place now because they are cheap to add to small tables
and expensive later: once a second tenant exists, the same X post legitimately belongs to two
channels, and swapping a global unique index under live traffic means dropping duplicate
protection while it rebuilds. `processed_posts.source_id` records which account a post came
from, and survives that source being deleted, so removing a source cannot cause its published
posts to be offered for review again.

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
- **A run has a time budget.** `/api/cron/sync` may run for 800 s (the Pro plan's maximum), but
  stops taking new posts after 560 s (`SYNC_TIME_BUDGET_MS`) and leaves the rest to the next run,
  with each source's cursor stopping at the last post it finished — nothing it did not reach is
  skipped. The response then carries `timeBudgetReached: true`. Requests have their own limits:
  30 s for X, 120 s for a media download and for a Telegram call. A Telegram call that times out
  is not resent in the same run, since it may have gone through; the post is retried by a later
  run.
- **The channel is append-only.** Deleting a Telegram message does not change the database; the
  post stays `published` and will not be re-sent. Delete its `processed_posts` row to republish.
- **`npm audit`** reports moderate advisories from `drizzle-kit`'s bundled esbuild. These are
  dev-only tooling and are not part of the deployed function.

## Licence

Provided as-is. You are responsible for complying with the X Developer Agreement, Telegram's
Terms of Service, and the copyright of anything you republish.
