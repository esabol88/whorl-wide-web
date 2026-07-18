# The Whorl Wide Web

A "TV Guide" style tracker for Book of the New / Long / Short Sun content —
new YouTube videos, podcast episodes, papers, Reddit discussions, fan art,
and mailing-list threads, gathered into one feed.

## How it works

- `fetch-content.js` — pulls items from each configured source (YouTube
  channels, podcast RSS, the Urth Mailing List, Reddit, DeviantArt) and
  writes them to `data.json`.
- `index.html` — the page itself. Fetches `data.json` on load; falls back to
  a small built-in sample set (with an on-screen note) if `data.json` isn't
  there yet. Saved items, spoiler progress, and last-visit tracking persist
  via real `localStorage` now that this runs outside the Claude.ai artifact
  sandbox.
- `favicon.svg` — the browser tab icon, adapted from the masthead's
  waning-sun mark (same shape, but with a solid fuligin background and
  thicker strokes so it stays legible at 16–32px). Referenced from
  `index.html`'s `<head>`; no separate build or PNG conversion needed since
  every modern browser supports SVG favicons directly.
- `.github/workflows/update.yml` — a free scheduled job (runs on GitHub's
  servers, no hosting needed) that re-runs the fetcher hourly and commits
  the refreshed `data.json`.

This gets you a fully automatic pipeline without paying for or running a
server: GitHub Actions does the scheduled fetching, GitHub Pages (or any
static host) serves the page. No API keys or registration are required for
any current source.

## A note on Reddit

Reddit is pulled via its plain **RSS** export
(`reddit.com/r/SUBREDDIT/.rss`), not the JSON API. As of May 2026, Reddit
blocks anonymous requests to `.json` endpoints — but the plain RSS export
was still open at the time this was written, no registration needed.
Reddit has signaled RSS could be locked down next, so if these sources
start failing later, that's the likely cause.

Four subreddits are configured: r/genewolfe, r/rereadingwolfepodcast,
r/alzabosoup, and r/shittygenewolfe. **The last three are still unverified**
— reddit.com isn't reachable from the tools I have available either, so I
couldn't directly confirm they exist. (For Rereading Wolfe specifically, I
used `rereadingwolfepodcast` rather than the requested `rereadingwolfe`,
since that's the name their own Apple Podcasts page lists.) Any that don't
exist will just show up as an ordinary `[skip]` line — check the actual
name against reddit.com and fix the `SOURCES` entry if one 404s. Adding
more subreddits is one line each, in the array right above the Reddit
source block in `fetch-content.js`.

Two real trade-offs versus the JSON API:
- **No thumbnails.** Reddit's RSS doesn't expose a usable image field, so
  Reddit items always show the fallback icon tile.
- **No attention filtering.** RSS doesn't expose vote counts, so this pulls
  whatever Reddit's RSS returns by default (its own front-page sort) rather
  than an explicit "only threads above N upvotes" cutoff.

### A note from the first live run

The first real run against actual reddit.com and DeviantArt (not just
locally) surfaced two things worth knowing:

- **Reddit rate-limited a burst of simultaneous requests.** All 4
  subreddit RSS fetches fired at once via `Promise.all`, and 3 of them came
  back `429 Too Many Requests` — only `r/genewolfe` got through. A 429
  means "you're going too fast," not "this doesn't exist," so it didn't
  actually answer the open question about the other 3 subreddits. Fixed:
  each Reddit source now waits an increasing delay (`redditDelayMs`, 3s
  apart) before firing, so they hit Reddit one at a time instead of in a
  burst. **Update:** a second live run at 3s spacing came back with the
  identical result — same 429s, same 40-item total. That rules out "our
  own requests are bursty" and points toward Reddit rate-limiting or
  blocking GitHub Actions' entire shared IP pool, a limit no amount of
  pacing on our end can get around, since it's shared across every other
  Action in the world hitting reddit.com at the same moment. Bumped the
  delay to 20s as a last check before concluding that for good — if that
  still doesn't move the needle, the real fix is a self-hosted runner (a
  non-shared IP), not more delay-tuning.
- **DeviantArt returned 403 Forbidden.** Likely blocking GitHub Actions'
  shared/datacenter IP ranges outright, a common defense against scraping
  — separate from the rate-limiting issue above.
- Both sources were also using a bot-labeled User-Agent
  (`wolfe-dispatch-bot/1.0`), which is exactly the kind of signal that
  invites this treatment. Fixed: switched to a realistic browser UA
  (shared across every fetch in this file via the `USER_AGENT` constant).
  Didn't change the outcome on the second run — consistent with this being
  IP-based rather than UA-based.

### A run that hung for 19 hours

One run got stuck "in progress" for 19 hours instead of finishing in a few
minutes. Root cause: the two raw `fetch()` calls used to scrape the Urth
Mailing List's Pipermail archive (it has no RSS feed, so this reads plain
HTML instead) had no timeout at all. Unlike the `rss-parser` instance,
which explicitly sets `timeout: 15000`, Node's built-in `fetch()` doesn't
time out on its own — if a connection stalls after the TCP handshake but
before any response arrives, it waits forever, and since everything else
in `main()` is waiting on the same `Promise.all`, one stuck source took the
whole job down with it. Fixed two ways:
- Both `fetch()` calls now pass `signal: AbortSignal.timeout(15000)`, so a
  stalled connection gets aborted after 15 seconds like every other source
  instead of hanging indefinitely.
- The workflow itself now sets `timeout-minutes: 15` on the job as a
  backstop — even if some other, unforeseen hang happens in the future,
  GitHub will force-kill the job quickly rather than let it run for hours.

## Fan art: DeviantArt, not Reddit (or INPRNT, or ArtStation)

Reddit's RSS can't reliably tell you "this post is an image" or who made
it, so fan art is pulled from **DeviantArt** instead
(`backend.deviantart.com/rss.xml`), which is a public search-as-RSS
endpoint — no login needed. It gives real structured data Reddit's RSS
doesn't: an actual image URL, the artist's username (attribution!), and a
content rating (`adult`/`nonadult`) that drives the NSFW blur directly,
rather than the title-text guess Reddit would've required.

The default query searches for `"gene wolfe"` — tune it in `SOURCES` if it's
pulling irrelevant results or missing good ones.

I checked two other likely candidates and neither can be a sitewide source
the way DeviantArt is:
- **ArtStation** has RSS, but only per-artist (`username.artstation.com/rss`)
  — no sitewide search/tag feed exists. ArtStation's own team has said
  algorithmic feeds (trending, search) don't work well as RSS.
- **INPRNT** appears to have no RSS or public search feed at all, and looks
  like a modern JavaScript-rendered storefront — even basic scraping
  likely wouldn't see real content without running an actual browser.
- **Tumblr** has the same per-blog-only limitation as ArtStation.

All three have a commented example in `SOURCES` for adding a *specific*
known artist/blog by hand — genuinely useful if you know one, not
something worth guessing at blind.

## What each item in data.json looks like

`data.json` is now `{ generatedAt, items }`, not a bare array — `generatedAt`
is an ISO timestamp from the fetcher's last run, separate from any item's
own date, so the site can tell "the pipeline ran recently" apart from "no
source happened to post anything new." (If you're upgrading from an older
copy of this project that wrote a bare array, this is a breaking format
change — regenerate `data.json` by running the fetcher once.)

Every item gets a stable `id` (an md5 hash of its URL, prefixed with a
source slug) — this is what `index.html` uses as the key for saved-item
stars, spoiler-reveal state, and NSFW-reveal state, so it needs to stay
consistent run to run rather than being random.

Items also get a best-effort `tags` array, matched against a short list of
major character names (`CHARACTER_TAGS` in `fetch-content.js`) — this
drives the clickable character pills on each card. It's a blunt keyword
match against the title/description, so it'll miss things and
occasionally over-tag; tune the list as you notice mis-tags.

One thing auto-fetched items deliberately do **not** get: a `book` value
(used by the Spoiler Shield to blur items past your reading progress).
Reliably figuring out *which specific chapter* a YouTube video or Reddit
thread discusses isn't something RSS text can support — so all fetched
items are spoiler-shield-neutral (never blurred) rather than guessed at.
If you want spoiler-tagged items, that has to be added by hand right now.

## Featuring an item

Set `featured: true` on any item in `data.json` (or `SAMPLE_DATA` in
`index.html`) and it gets pulled out into a full-width slot above the feed,
with a colored "Featured · [source]" label. It's excluded from the regular
feed below so it doesn't show twice. This is manual/editorial on purpose —
the fetcher has no way to judge "this is a big drop," so nothing is
featured by default. Only one item can be featured at a time (the first one
found); un-set the old one before setting a new one if you're doing this by
hand in `data.json`.

## Search

The search box (above the series/format filter chips) matches against an
item's title, description, source name, and character/theme tags —
client-side only, no server or index needed given the feed's size. It
combines with the series/format/saved/tag filters (all of them have to
match), and the featured slot hides itself if it doesn't match an active
search, so you don't get an unrelated pinned card sitting above search
results that have nothing to do with it. Press Escape or hit the × to
clear.

## Filters persist across visits

Series, format, saved-only, and character-tag filters are saved to
`localStorage` and restored on your next visit — close the tab filtered to
"New Sun + Podcast" and it's still set that way tomorrow. Search is
deliberately excluded from this: a query is a one-off lookup, not a
standing preference, so it always starts empty.

## Spoiler Shield progress auto-advances

Revealing a spoiler-blurred card is a direct signal you've read at least
that far, so the Shield's per-series progress quietly advances to match
instead of waiting for you to go find the dropdown and update it yourself.
It only ever moves forward, never back, and only for the series that item
belongs to. A one-line note appears in the status area the moment it
happens ("Spoiler Shield for New Sun updated to through Sword of the
Lictor") so it's not an invisible, unexplained change — you'll notice it
once, then it's just quietly correct from then on.

## First-visit onboarding banner

A brand-new visitor (nothing in `localStorage` yet) sees a small banner
above the fold, before anything else: "First time here? Let's avoid
spoiling anything," with two buttons — jump straight to the Spoiler Shield
selects, or declare yourself caught up on everything. Dismissing it either
way (including the × ) marks onboarding done so it never shows again.
Fixed a real bug in the same pass: the *old* default for a brand-new
visitor's progress was `'all'` (all caught up — nothing blurred), which is
backwards — someone who's told the site nothing about their reading should
get maximum protection, not none. New visitors now default to `'none'`
(haven't started) for every series until they say otherwise, whether via
the banner or the Shield panel directly.

## "Updated Xh ago" and quiet-source detection

The masthead shows when the fetcher last actually ran (from `generatedAt`
in `data.json`), separate from any item's date — so you can tell "the
pipeline is healthy but nothing new happened" apart from "the Action broke
and this is stale."

Separately, each source's *own* freshness is tracked too: a channel whose
RSS feed hasn't produced anything newer than `STALE_DAYS` (60 by default,
tunable in `index.html`) gets a small "quiet 3mo ago" badge on its newest
item in the feed, and the status line adds a one-line summary ("2 sources
quiet 60+ days") with the names on hover. This needs no extra work from the
fetcher — a dormant channel's RSS just keeps returning its old items every
run, so the frontend can already see this directly in `data.json` without
fetch-content.js tracking anything new. This was the exact failure mode
visible in a friend's similar site (WoTV Guide) — channels frozen at 30+
months with nothing in the UI flagging it — so this makes it visible
instead of silent.

## Setup

1. **Create a GitHub repo** and push these files to it.

2. **Fill in real sources** in `fetch-content.js`:
   - YouTube channel IDs for Rereading Wolfe and Marc Aramini are already
     filled in.
   - Alzabo Soup's podcast RSS feed is confirmed and filled in
     (`alzabosoup.libsyn.com/rss`). For any others you add, use the show's
     actual RSS feed URL — usually found on the podcast's own site, or by
     searching the show on [Podcast Index](https://podcastindex.org) or
     Apple Podcasts.
   - For YouTube channels you add, you need the channel's `channel_id`
     (starts with `UC...`), not its `@handle`. Easiest way to find it: open
     the channel page, view source, search for `"channelId"`.
   - The Urth Mailing List, Reddit, and DeviantArt sources are
     pre-configured and need no setup.

3. **The frontend is already wired to fetch `data.json`** — no manual swap
   needed anymore. `index.html` fetches `./data.json` on load; if it's
   missing or empty (e.g. before the Action has run once), it falls back to
   a small built-in sample set and shows a "Showing sample data" note so
   that's obvious.

4. **Turn on GitHub Pages** for the repo (Settings → Pages → deploy from
   `main` branch). Your page will be live at
   `https://<you>.github.io/<repo>/`.

5. **Turn on the Action.** It's already scheduled hourly
   (`.github/workflows/update.yml`); you can also trigger it manually from
   the repo's Actions tab to test it right away.

## Extending

- **More sources**: add entries to the `SOURCES` array in
  `fetch-content.js` — each one is ~5–15 lines.
- **Twitter/X, Instagram, TikTok**: no free public feeds. Realistic options
  are (a) a paid API tier, or (b) manually curating notable posts into
  `SAMPLE_DATA` in `index.html`, or directly into `data.json`.
- **Series tagging**: the fetcher does simple keyword matching (see
  `KEYWORDS` in `fetch-content.js`) to guess whether an item is about New,
  Long, or Short Sun. Tune the keyword lists as you see mis-tags.
