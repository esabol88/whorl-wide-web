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

Three subreddits are configured: r/genewolfe, r/rereadingwolfepodcast, and
r/shittygenewolfe — all confirmed live via real runs against reddit.com
(see "All three originally-unverified subreddits: resolved" further down
for the full story, including why `r/alzabosoup` isn't in the list).
Requests to Reddit are deliberately staggered 65 seconds apart rather than
fired all at once — see the comment above the Reddit source list in
`fetch-content.js` for why. Adding more subreddits is one line each, in
that same array.

One real trade-off versus the JSON API remains: **no thumbnails.** Reddit's
RSS doesn't expose a usable image field, so Reddit items always show the
fallback icon tile.

The other original trade-off — no attention filtering, since RSS never
exposes raw vote counts — turned out to have a real fix: each subreddit
uses `/top/.rss?t=month` instead of the default feed. Reddit computes that
ranking from real vote data server-side before the feed ever reaches us,
so the *ordering* is a genuine engagement signal even though the raw score
number is still invisible to us — "top of the month" versus "whatever's
merely recent." Capped at 6 items per subreddit rather than 15, too, so a
slow month's worth of "top" posts doesn't still outnumber every other
source by sheer volume. `t=month` is tunable to `week`/`year`/etc. in the
Reddit source list if a subreddit's posting frequency wants a different
window.

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
- The workflow itself now sets `timeout-minutes: 20` on the job as a
  backstop — even if some other, unforeseen hang happens in the future,
  GitHub will force-kill the job quickly rather than let it run for hours.

### Solved: the timing instrumentation paid off

A run with timing enabled showed exactly what was going on:

- **`r/shittygenewolfe` exists.** It succeeded at the 60-second stagger
  mark while `r/rereadingwolfepodcast` (20s) and `r/alzabosoup` (40s) both
  still got `429`. That's a real pattern — Reddit's rate-limit window looks
  to be somewhere around a minute, not an unconditional IP-pool block after
  all. Bumped the stagger from 20s to 65s per source based on this
  evidence.
- **The "why is this taking 15+ minutes" mystery had nothing to do with
  Reddit at all.** Every source's own `[timing]` log finished within about
  a minute, but the step itself took 5 minutes — a multi-minute gap of dead
  time *after* the real work was already done and logged. That's Node's
  process staying alive after `main()` returns, most likely a dangling
  keep-alive connection somewhere in `rss-parser` or `fetch` that never got
  explicitly closed. Fixed: `main()` now explicitly calls `process.exit(0)`
  when it's actually done rather than waiting for the event loop to drain
  on its own, and `.catch()`s into `process.exit(1)` on failure so errors
  get a proper non-zero exit code too (the bare `main();` call before this
  didn't guarantee that).

### All three originally-unverified subreddits: resolved

With the 65s stagger and the process-exit fix in place, a clean run
confirmed the last open questions from the very start of this project:

- **`r/rereadingwolfepodcast` — exists.** Succeeded at 65s.
- **`r/shittygenewolfe` — exists.** Succeeded consistently across two runs.
- **`r/alzabosoup` — confirmed NOT to exist.** Failed with `403` (not
  `429`) on two separate runs despite a 130s delay — a `403` on Reddit
  usually means private/banned/quarantined/gone rather than rate-limited,
  and visiting the URL directly in a browser confirmed it: page not found.
  Removed from `SOURCES` entirely rather than left in as a permanent
  `[skip]` line — no point re-querying a subreddit that's confirmed to not
  exist on every hourly run. If Alzabo Soup ever starts a subreddit, add it
  back the same way as the others.

DeviantArt's `403` stayed completely consistent across every run — same
error, same near-instant (~0.1–0.2s) failure every time, regardless of
User-Agent or timing changes. That consistency points at IP-range blocking
of GitHub Actions' shared runner pool specifically, which isn't fixable
from inside a GitHub-hosted Action. Left the source in `SOURCES` rather
than removing it, since — unlike a confirmed-nonexistent subreddit — this
could plausibly work again from a different environment (e.g. a
self-hosted runner on a non-shared IP) even though it doesn't work here.

## Fan art: DeviantArt, Bluesky, and now Reddit

Fan art comes from three places. **DeviantArt**
(`backend.deviantart.com/rss.xml`) is the most structured — a public
search-as-RSS endpoint, no login needed, with real fields Reddit's RSS
doesn't have: an actual image URL, the artist's username for attribution,
and a content rating (`adult`/`nonadult`) that drives the NSFW blur
directly.

The default DeviantArt query searches for `"gene wolfe"` — tune it in
`SOURCES` if it's pulling irrelevant results or missing good ones.

**Reddit fan art** was added after noticing r/genewolfe actually gets a
decent amount of it — detected within the same `/top/.rss` feed already
used for discussion threads, not a separate source. Reddit's RSS embeds a
rendered HTML snippet per post (exposed as `item.content` by rss-parser,
separate from the plain-text `item.contentSnippet`); for image/link posts
that snippet includes an `<img>` thumbnail. `extractRedditThumbnail` in
`fetch-content.js` pulls that out, and any post where it finds one gets
reclassified from `discussion` to `fanart` automatically — same feed,
split by content rather than a second fetch.

One real gap versus DeviantArt, and one that turned out fixable on a
second look:
- **Artist attribution was fixed, not accepted.** The original "Reddit's
  RSS doesn't expose the poster's username" claim was inherited from the
  very first project handoff and never actually re-verified against real
  code — on a closer look, Reddit's feed is Atom format, and Atom entries
  commonly carry a structured `<author><name>` field, which `rss-parser`
  normalizes into `item.creator` automatically. `extractRedditAuthor` in
  `fetch-content.js` now tries that first, and falls back to a
  `/u/username` text pattern in the same embedded content HTML already
  used for thumbnail extraction if the structured field isn't populated.
  Still falls back to "Unknown artist" if genuinely neither signal is
  present — but that's now a real fallback for missing data, not a
  permanent ceiling.
- **No real NSFW signal.** There's no content-rating field to check the
  way DeviantArt's `media:rating` provides. The fallback
  (`redditTitleNsfw`) only flags a post if its own title literally
  contains the word "nsfw" — a weak, best-effort heuristic that **will
  miss real NSFW content that isn't self-tagged in the title.** Worth
  actually watching once this is live, given what's at stake if it
  under-flags something the Spoiler Shield's NSFW blur was supposed to
  catch.

**Not verified against the live API** — same situation as Crossref and
Bluesky originally were: I can't reach reddit.com from the sandbox this
was built in, so both the `<img>`-extraction and the new author-extraction
logic are built from the documented shape of Reddit's RSS output, not a
real test run. Check the first live
run: does the Fan Art filter actually show real Reddit-sourced images, or
does nothing show up (meaning the extraction didn't match anything)?

I also checked two other likely fan-art candidates, and neither can be a
sitewide source the way DeviantArt is:
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

## Fan art: Bluesky, in addition to DeviantArt

Unlike Tumblr/ArtStation, Bluesky has a genuinely different option: a
public, unauthenticated search API
(`public.api.bsky.app/xrpc/app.bsky.feed.searchPosts`) that searches *all*
of Bluesky for a query, not just one account. Implemented in
`fetchBlueskyArt` — filtered hard to posts that actually have an image
embed, since this searches all posts matching the query text, not art
specifically. That filter is the only thing keeping this to pictures at
all; there's no way to tell "this image is fan art" from "this image is a
photo of the book cover" or "this image is an unrelated meme" from the API
alone, so expect more noise here than from DeviantArt's dedicated art
search. Tune the `query` in `SOURCES` if it needs adjusting.

Content warnings map from Bluesky's own self-applied labels (`porn`,
`sexual`, `nudity`, `graphic-media`) to the NSFW blur, the same idea as
DeviantArt's content-rating field, just a different vocabulary.

**Confirmed blocked on a live run** — `403` in ~0.2s, the identical
signature to DeviantArt's failure (near-instant, not a rate-limit-style
delay). That points at the same cause: GitHub Actions' shared IP pool
being blocked outright by Bluesky's API too, not something pacing or
headers can fix. Left in `SOURCES` anyway, same reasoning as DeviantArt —
it could plausibly work from a different environment even though it
doesn't work here.

## Scholarly papers (Crossref)

Pulls recent journal-article metadata matching "Gene Wolfe" from
[Crossref](https://www.crossref.org) — the same DOI registry most academic
publishers use, free and keyless. Deliberately used instead of something
like the Semantic Scholar API, which is excellent but skews hard toward
CS/AI coverage; literary scholarship on Wolfe is far more likely to turn up
in Crossref via journals like *Extrapolation* or *Science Fiction Studies*.

The link Crossref returns is the DOI landing page, which is very often
paywalled — that's expected, not a bug. The point is surfacing that a paper
exists, the same as a citation would, not guaranteeing free full-text
access.

**The connection worked on the first live run, but the results didn't** —
the feed filled up with completely unrelated genetics papers ("Gene
Expression," "IL13 and IL18 Gene," and similar). Cause: Crossref's
`query.bibliographic` has no exact-phrase support (confirmed against their
own issue tracker), so a "Gene Wolfe" query was matching on the common
word "gene" alone, with no real requirement that "Wolfe" appear anywhere.
Fixed: `fetchCrossref` now pulls a much wider candidate pool (50 instead of
15) and hard-filters to results that actually contain "wolfe" in the title
or abstract — a far rarer, more specific token, which is what actually
enforces relevance here, not the query. Worth knowing: a genuine Wolfe
paper whose title/abstract never literally says "Wolfe" would now get
filtered out too — an acceptable trade, since a missed real paper is a much
smaller problem than a feed full of unrelated genetics research.

**Second bug, found via the per-source item-count logging added after the
first fix:** two consecutive live runs of the exact same code returned 15
items, then 0. Cause: the *candidate pool* (the 50 items fetched before
the wolfe-content filter runs) was sorted by `published desc` — most
recently published first, across every field the fuzzy query loosely
matched. Since "gene" alone is a very common word in unrelated
high-volume fields like genetics, and actual Wolfe scholarship publishes
comparatively rarely, whatever happened to be freshly published that
particular week could completely fill the 50-item window with zero real
matches, even though relevant papers existed elsewhere in Crossref's
index. Fixed: the initial query no longer sorts by date at all (left at
Crossref's default, relevance-to-the-query ranking), so the candidate pool
is chosen by how well it matches "Gene Wolfe," not by what's newest.
Date-sorting now happens in a second pass, only among the items that
survived the wolfe-content filter — recency still decides *display order*,
it just no longer decides *which candidates get considered* in the first
place.

One more thing the item-count logging surfaced, not yet acted on: the
**Urth Mailing List returned only 1 item** on the same run, well below its
usual handful. Not obviously broken (no error, no skip) — could just be a
genuinely quiet month on a list that's already documented as intermittent
— but worth keeping an eye on over a few more runs rather than assuming
either way.

## Patreon (specific tracked creators, not a sitewide search)

Empty by default — this is opt-in, not automatic. Patreon has no official
public feed for a creator's general posts (its "Public RSS" feature is
opt-in per creator and audio-podcast-episodes only, so it wouldn't cover
Rereading Wolfe's text posts even if enabled). What this uses instead is
the same **undocumented internal API** Patreon's own website calls to load
a creator's page — the same approach a couple of open-source projects
(`patreon-rss`, `patreon-feed`) have reverse-engineered, not something
Patreon publishes or supports for third parties.

**This is meaningfully more fragile than every other source in this
file.** Everything else here is built against a real, documented,
supported API or a stable, decades-old HTML structure. This one has no
stability guarantee at all — it could change shape or get blocked without
any notice, since Patreon isn't maintaining a contract with third parties
the way Crossref or Bluesky are. Went ahead with it anyway on request, with
that tradeoff made explicit rather than glossed over.

**To add a creator**, you need their numeric Patreon ID — not their
username, there's no simple lookup for it. Two ways to find it:
1. View page source on their Patreon page, search for
   `https://www.patreon.com/api/user/` — the number right after it is the
   ID.
2. On their page, open the browser console and type:
   `patreon.bootstrap.campaign.data.relationships.creator.data.id`

Then add one line to the (currently-empty, commented-out example) Patreon
section in `SOURCES` in `fetch-content.js`. Rereading Wolfe is the obvious
first candidate given the Start Here reading-order link elsewhere on this
site, but I don't have their numeric ID — it isn't something search
engines index.

Paid/members-only posts still come through with a title and a link even
without authentication — their content field is typically empty, which
falls back to a plain "Members-only post" note rather than showing a blank
card, the same spirit as Crossref surfacing a paywalled DOI link.

**Not verified against the live API** — same situation as Crossref and
Bluesky originally were: I can't reach api.patreon.com from the sandbox
this was built in. Built from a real, working open-source implementation's
source code, not a guess — but still needs a real run (once you've added a
creator ID) to actually confirm.

## Written Wolfe content beyond Patreon

Prompted by a round of research into where else serious written Wolfe
content lives, beyond what was already covered. Two real additions, one
promising lead I didn't wire in, and several deliberate skips — the same
"don't become an undifferentiated dump" judgment call already made for
Reddit (top-of-month only) and Bluesky (image-embed filter only).

The `[timing]` log line for every source now also shows how many items it
actually contributed (`[timing] SourceName: 1.2s (4 items)`), not just how
long it took — added after a run where the total item count dropped even
though *more* sources succeeded than the previous run, and there was no
way to tell which source's contribution shrank without this.

**Added:**
- **Ultan's Library** (`ultan.org.uk`) — wholly Wolfe-dedicated since 2000,
  essays and reviews from real Wolfe scholars. **Confirmed live** —
  succeeded on a real run. Infrequent (its own most recent visible post
  was from mid-2024 at the time of writing) but genuine — same category as
  Alzabo Soup or the Urth Mailing List: real signal, low volume, not a
  reason to exclude it.
- **Reactor's Gene Wolfe tag** (`reactormag.com/tag/gene-wolfe/`) — a
  major professional SFF outlet (formerly Tor.com), scoped to their Gene
  Wolfe tag specifically rather than their whole front page, which would
  be almost entirely unrelated content otherwise. Real editorial writing
  by named critics, not reader submissions. **Confirmed live.**
- **Martin Crookall's blog** (`mbc1955.wordpress.com`) — general-subject
  blog, real Wolfe coverage, scoped down with `requireKeyword: 'wolfe'`
  the same way Wolf is below. **Confirmed live.**

**Added, but confirmed blocked — same as DeviantArt and Bluesky:**
- **"Wolf" by radicaledward** (Substack) — not a dedicated Wolfe blog, a
  general personal newsletter (games, a parenting podcast, serialized
  fiction, thousands of subscribers) that ran a Book of the New Sun
  chapter-by-chapter read as one section, now on hiatus. Originally left
  this off entirely for being general-interest — correctly pushed back on:
  excluding a whole source because *most* of it is irrelevant throws away
  the part that isn't, when filtering the noise out is just as available
  here as it was for Crossref. Added a general mechanism for this rather
  than a one-off: any RSS source can now set `requireKeyword` in
  `SOURCES`, and only items whose title/description actually contain that
  word survive — Wolf and Crookall above both use it. But on a live run,
  Wolf came back `403` in ~0.4s — the same near-instant signature as
  DeviantArt and Bluesky, a third platform now pointing at the same root
  cause (GitHub Actions' shared IP pool blocked outright, not anything
  fixable here). Left in `SOURCES` anyway, same reasoning as the other
  two — could plausibly work from a different environment.

**Found but not wired in — worth checking by hand:**
- **Michael Andre-Driussi's Goodreads author blog.** Genuinely exciting —
  he's the Lexicon Urthus author already on the Reference Shelf, and he's
  actively posting real Wolfe analysis there, as recently as this year. I
  couldn't confirm Goodreads exposes RSS for an individual author's blog
  specifically, though (their per-book-shelf RSS is real and
  well-documented; the blog/"News" section appears to be a different,
  RSS-less feature based on someone else's direct account of researching
  this same question). Didn't want to wire in a guessed URL. Worth five
  minutes checking by hand: `goodreads.com/author/show/52075` — if there's
  a real feed, this is a strong add.

**Deliberately not added as automated feeds** (would pull mostly
unrelated content even with keyword filtering, since Wolfe coverage here
is a single one-off post rather than an ongoing, findable pattern):
- **Don Beck's The Reading Room, Synthesized Sunsets, Counter Craft, The
  Hobbyhorse** — general SFF/literary newsletters that have each published
  one worthwhile Wolfe essay at some point, not dedicated Wolfe sources.
  Pulling any of their full feeds would be almost entirely non-Wolfe
  content for the sake of one good post.

**Added to the Reference Shelf instead of as feeds** (static resources,
not ongoing publications):
- **Gwern's Gene Wolfe archive** — a large compiled index of otherwise-
  scattered interviews and essays.
- **Newsun's Word Hoard** — Andre-Driussi's free Kindle dictionary
  overlaying Lexicon Urthus definitions directly onto the New Sun ebooks.

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

### Date labels now show the year when it's not the current one

A card's date used to always show as bare "MON DAY" with no year. The feed
is correctly sorted by full date underneath, but once it mixes recent
items with a quiet source's years-old ones, a bare "MON DAY" label made a
genuinely correctly-ordered list *look* shuffled — e.g. "JAN 22" sitting
between two items both labeled "AUG 7" reads as broken chronology unless
you know one January is 2026 and the other August is 2021. Fixed: the
label now includes the year whenever it isn't the current calendar year
(same convention as Gmail or Twitter), so "JAN 22, 2026" and "AUG 7, 2021"
are each unambiguous at a glance instead of colliding on "MON DAY" alone.

## A UX pass, grounded in specific named principles

Read through Laws of UX, the UX Design Institute's breakdown of the same,
and Nielsen Norman Group's 10 usability heuristics, then checked the actual
code against them rather than restyling on vibes. Three genuine gaps found:

- **Fitts's Law** (time to hit a target is a function of its size and
  distance): the save-star button was a ~19px tap target — 2px of padding
  around a 15px glyph, on every single card. Well under the ~44px commonly
  recommended minimum, especially rough on mobile. Now 30×30px with a
  hover state, same visual glyph size, just a real hit area around it. Tag
  pills got a smaller version of the same fix (4px→6px vertical padding).
- **NN/g heuristic #1 (Visibility of System Status) and #6 (Recognition
  Rather than Recall)**: filtering the feed down gave no count anywhere —
  you'd have to actually count cards to know how many results you were
  looking at. The status line now shows "N matching dispatches" whenever
  any filter is narrowing the view, replacing the freshness message (which
  isn't the relevant fact anymore once you're mid-filter).
- **NN/g heuristic #3 (User Control and Freedom)**: five independent
  filter mechanisms — series, format, character tag, search, saved-only —
  each had their own individual reset, but no single "start over." A
  "Reset filters" button now appears next to the result count whenever any
  filter is active, clearing all five at once.

Not every principle in those three sources applies here — Miller's Law
(7±2 items in working memory) would argue against the filter row having
13 simultaneous chip options, for instance, but splitting series and
format into two visually distinct rows already chunks that choice in a way
that seemed to make restructuring it not worth the disruption. Mentioned
for transparency, not silently skipped.

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
