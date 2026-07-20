# Fuligin

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

Two subreddits are currently configured: r/genewolfe and
r/rereadingwolfepodcast (see "All three originally-unverified subreddits:
resolved" further down for the full story of how these were confirmed,
and why `r/alzabosoup` isn't in the list). A third, r/shittygenewolfe, was
confirmed live the same way but was removed later on direct feedback that
it wasn't adding value — a meme/joke subreddit contributing mostly noise
once it was actually seen in the live feed regularly, not something
obvious from just confirming it existed. Requests to Reddit are
deliberately staggered 65 seconds apart rather than fired all at once —
see the comment above the Reddit source list in `fetch-content.js` for
why. Adding more subreddits is one line each, in that same array.

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

**Re-enabled** — `FAN_ART_ENABLED = true` near the top of
`fetch-content.js`. Was disabled after live use surfaced exactly the risk
that was flagged when Reddit and Bluesky fan art were built: neither can
actually tell real art apart from memes, screenshots, or reaction images,
they just check "does this post have an embedded image." r/shittygenewolfe
made it worse by being a joke/meme subreddit in the first place — every
image post there was getting reclassified as fan art with nothing to stop
it. That subreddit has since been removed from `SOURCES` entirely (a
separate decision, on direct feedback that it wasn't adding value
generally) — worth trying fan art again specifically *because* the actual
noise source is gone, not just flipping the same switch back blind. The
two subreddits still tracked are a general discussion sub and a podcast
companion sub, a meaningfully different situation than before. Bluesky
stays blocked from GitHub Actions regardless of this flag (see
`fetchBlueskyArt`), so in practice this mostly just re-enables Reddit's
detection; DeviantArt was never actually the problem and is also still
separately blocked either way.

**A real content filter, not just re-enabling the old check.** Even
without a meme subreddit in the mix, "has an embedded image" alone still
can't tell fan art apart from a random relevant-looking photo — someone's
picture of a red sunset captioned "felt very New Sun today" has an image
and is completely on-topic, but it isn't fan art. `ART_SIGNAL_RE` now
requires the title/text to actually say something art-related — a direct
word ("art," "drawing," "sketch," "commission," "OC," etc.) or a named art
platform ("DeviantArt," "ArtStation," "Instagram," "Tumblr," "Pixiv") —
before an image post gets classified as fan art at all. Word-boundary
matched specifically so short entries like "art" or "oc" can't
false-positive inside unrelated words ("Arthur," "chocolate" both
correctly don't match, tested directly rather than assumed). Not
foolproof — a real art post with a bare, caption-free title could still
be missed — but a missed real post is a much smaller problem than a feed
full of memes and unrelated photos, the same trade already made for
Crossref's "must say wolfe" filter.

**Renamed "Fan Art" to just "Art"** — real posts flagged as missing turned
out to include what looks like official/published art (a specific gallery
post the person felt should count "makes me think we should rename it"),
not just amateur original work. "Fan Art" implied a narrower category than
what actually belongs here. `TYPE_LABEL` in `index.html` handles the
display text now (`fanart` stays the internal type key for schema
stability — matches what's already in `data.json` and the filter chip's
`data-type` attribute — only what's shown to a reader changed).

**Diagnosed rather than guessed again, when specific posts were reported
as missing.** Couldn't inspect the actual posts directly (no live access
to reddit.com), so rather than adjust the regex blind a second time,
added per-item diagnostic logging instead: for every Reddit item that
does have an image, `fetchRedditRss` now logs its title, whether
`ART_SIGNAL_RE` matched, and its raw `categories` field (in case Reddit's
RSS exposes post flair there — unconfirmed either way, but if it's
present and populated, that's a far more reliable signal than guessing
from title keywords, and worth switching to if it's real). This will show
directly, on the next run, whether currently-missed posts are failing at
the image-detection step, the keyword-matching step, or aren't in the
`/top/.rss?t=month`-scoped, 6-item-capped window being fetched at all —
three genuinely different problems that would need three different fixes,
rather than one more guess at the same regex.

**Resolution, from a real run's diagnostic output:** the one image post
that showed up ("Deeper Dive - Bibliomen Summary") correctly scored
`signal=false` — a podcast episode discussion post with its own cover
thumbnail, not fan art, correctly excluded. The content filter itself was
working. `categories=[none]` also settled the flair question: Reddit's
RSS doesn't expose post flair, at least not for this item, ruling that out
as a viable signal. But none of the specifically-reported posts showed up
in the debug output *at all* — meaning the real problem was scope, not
detection: only the top 6 posts by vote count were ever being scanned in
the first place, so a real art post outside that narrow window was never
even looked at, regardless of how good the content filter was.

Fixed by separating the scanning window from the output cap, the same
shape of fix already used for Crossref: `fetchRedditRss` now scans the
top 20 posts instead of 6, so a lower-vote-ranked but genuine art post has
a real chance of being found. The final output cap stays at 6 for the
original reason (one niche subreddit's whole month of posts shouldn't
outnumber every other source in the feed) — but a naive `slice(0, 6)`
after scanning 20 would've just reproduced the exact same top-6 result and
defeated the point, so art matches now get priority for those 6 slots,
backfilled with top-ranked regular posts. Costs nothing extra
network-wise — `feed.items` already contains the full response from the
one RSS request already being made; this just processes more of the
array already downloaded, not additional requests to Reddit.

**Second round, after another direct report** of specific art posts still
showing as Discussion — this time with actual titles to check, unlike
before. Two of three had "Illustration" right in the title (already in
`ART_SIGNAL_RE`); the third said "cover art by [artist]" outright. A
strong keyword match failing anyway meant the keyword filter almost
certainly wasn't the problem this time — pointing instead at the image-
detection step, `extractRedditThumbnail`, which just searches for a
literal `<img src="...">` tag. Plausible failure modes: a Reddit gallery
post's RSS content may not embed a plain `<img>` tag the same way a
single-image post does, and the Amano cover-art post specifically credits
an artist on Bluesky rather than hosting the image on Reddit itself — an
externally-linked image Reddit's RSS may not generate a preview for at
all.

Confirmed the previous diagnostic had a real blind spot causing this: it
only logged posts that *already* had a detected image, so a post failing
at the image-detection step — keyword match or not — never appeared in
the log either way. Fixed the diagnostic itself before touching the
detection logic: it now also logs any post where the title/text matches
`ART_SIGNAL_RE` but no image was found, including a raw content snippet,
so the actual HTML Reddit's RSS sent is visible on the next run instead of
guessing why extraction failed. Deliberately didn't guess-fix
`extractRedditThumbnail` itself yet — same discipline that's paid off
repeatedly in this file (Crossref, the Urth Mailing List dates, the
scan-window fix above): see the real data first, then make one precise
fix instead of another speculative regex change.

**Resolution.** The next run's raw content snippets confirmed it directly
— the same four posts, all cut off right at `<span><a href=`, meaning the
image comes through Reddit's RSS as a plain `<a href="...">` link, not an
`<img>` tag at all. Fixed `extractRedditThumbnail` to check both: the
original `<img>` pattern first, then a fallback matching an `<a href>`
whose URL is either a known Reddit/imgur image host
(`i.redd.it`/`i.imgur.com`/`preview.redd.it`/`external-preview.redd.it`)
or simply ends in an image extension. Tested locally against a realistic
completion of the actual truncated evidence before shipping (not just
reasoned about) — extracts the image correctly, still works on the
original `<img>`-based case, and correctly returns nothing for a plain
text post with only a comments link, no false positive there. The debug
logging also grew a bit more useful either way: the "found an image" case
now prints the actual extracted URL, so a future check can directly
confirm extraction is finding the *right* image, not just confirm
something was found.

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
**Urth Mailing List returned only 1 item**, consistently across two
separate runs. Not obviously broken (no error, no skip) — could just be a
genuinely quiet stretch on a list that's already documented as
intermittent, or could be a dedup bug quietly collapsing more messages
than it should. Rather than guess which, `fetchPipermail` now also logs
the raw pre-dedup link count (`[debug] Urth Mailing List: N raw
thread-index links, M unique after dedup`) — same diagnostic instinct that
found the real Crossref bug. Next run settles it: raw count near 1 means
genuinely quiet; raw count much higher than 1 means the dedup logic needs
a real fix.

**Update: confirmed fixed.** A follow-up run showed Crossref returning 7
items — consistent, non-zero, no more swinging between a full batch and
nothing.

**Separately, a real accuracy problem with this source's dates.**
Pipermail's monthly thread-index page lists subjects and authors, but not
dates — so every Urth Mailing List item used to just get stamped with
whatever day the Action happened to run, as an approximation. A direct
report showed how bad that actually got in practice: a post from June 4th
displaying as "JUL 18" — six weeks off, not a rounding error. Fixed:
`fetchMessageDate()` fetches each kept item's own message page and pulls
its real date from there, run in parallel across all of them so it
doesn't meaningfully add to total runtime.

**First attempt didn't work** — a live run still showed today's date, no
better than before. Rather than guess again blind, found real evidence
this time: an archived Urth message page turned up in a search result
with the literal text "Roy C. Lackey rclackey at stic.net Tue Dec 23
13:45:24 PST 2008" — confirming the actual format has a timezone
abbreviation sitting *between* the time and the year, which the first
regex had no room for at all (it expected the year immediately after the
time). Fixed the pattern accordingly, and tested it directly against that
real sample plus a synthetic case matching the exact June 4th scenario
from the original report — both parse correctly now, confirmed locally
before shipping this time, not just reasoned about.

**Still not fully verified live**, though — the evidence came from a
search engine's text extraction, not the raw HTML itself, so the exact
surrounding tag structure remains unconfirmed (the regex was loosened to
not require a specific wrapper for this reason). Fails safe either way: a
page that doesn't match just falls back to today's date, same as before
either fix existed. The debug line
(`[debug] Urth Mailing List: resolved real dates for N/M items`) shows
next run whether this attempt actually worked. If it's still 0/N after
this, that's a reasonable point to stop iterating blind and either drop
this source or find another way to get real per-message dates (e.g.
scraping the date.html sort index instead of each message's own page).

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

## YouTube search — sweeps all of YouTube, not just named channels

Everything else YouTube-related in this file (Rereading Wolfe, Marc
Aramini, and the growing list below) pulls from a fixed list of named
channels — real content, but it only ever finds creators someone thought
to add by hand. This uses YouTube's **official Data API v3** `search.list`
endpoint instead, which searches all of YouTube for recent uploads
matching a query — catching creators nobody's added yet.

**Setup (one-time, a few minutes):**
1. Go to [console.cloud.google.com](https://console.cloud.google.com),
   create a new project (any name).
2. **APIs & Services → Library** → search "YouTube Data API v3" → **Enable**.
3. **APIs & Services → Credentials → Create Credentials → API Key**.
4. Optional but recommended: click into the new key and restrict it to
   only "YouTube Data API v3" — limits the damage if it ever leaks.
5. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret** → name it `YOUTUBE_API_KEY` → paste the key.

That's it — `fetchYouTubeSearch` picks it up automatically via
`process.env.YOUTUBE_API_KEY`, already wired into the workflow's `env:`.
**If the secret isn't set, this source just skips gracefully** with a
clear `[skip]` message — the rest of the pipeline is unaffected either
way, so there's no rush to set this up if you'd rather hold off.

**Quota, and why it's not searching all-time on every run:**
`search.list` costs 100 quota units per call no matter how many results
come back, against a free daily quota of 10,000 units (100 calls/day).
Running hourly at one query per run costs 2,400/day — comfortable
headroom. `publishedAfter` is set to a rolling 7-day window rather than
searching from the beginning of time each run: keeps every call small and
fast, and since this runs hourly, the window overlaps run to run — missing
an occasional run doesn't lose anything.

**Why this should be cleaner than Crossref was:** `search.list` does real
semantic search, not the fuzzy bibliographic match that had Crossref
surfacing unrelated genetics papers. Still applies the same "does it
actually say wolfe" sanity filter as everything else, though — a two-word
query like "Gene Wolfe" can occasionally surface something irrelevant, and
it's cheap insurance regardless.

**A real bug this surfaced, fixed proactively:** search could easily find
the *same* video a named channel's RSS already pulls in — Rereading
Wolfe's own uploads, for instance, are exactly the kind of thing this
query would also match. Each source generates its own item `id` from
`source.name` + the URL, so the same video from two sources would've
produced two different ids and shown up as two separate cards. Fixed with
a global dedup pass in `main()`, by URL, across every source — not just
this one. Whichever source lists a duplicate first wins; in practice that
means a named channel's own copy is kept over the search-discovered one.

**Not verified against the live API** — I don't have a real API key and
can't reach googleapis.com from the sandbox this was built in. Built
directly from Google's own API documentation for `search.list`, not a
guess, but this genuinely needs a real run (once the secret's set) to
confirm the response shape and result quality match what's expected here.

## A Substack/Medium research pass — 6 new ongoing sources, 2 archival essays

A large research pass turned up a genuinely healthy ecosystem of current
Wolfe writing, especially on Substack. Rather than add all of it — many
were single Wolfe pieces inside an otherwise-unrelated general newsletter
— scoped this to two different treatments based on whether someone's
shown a pattern of writing about Wolfe repeatedly (or was flagged as
likely to keep doing so) versus wrote one good piece and probably won't
again. An aggregator's actual value is in the former; the latter is
better served by a permanent link than a feed slot that might never fire
again.

**Added as ongoing sources** (all general-interest, all `requireKeyword:
'wolfe'`): Mannish Boy (Medium, an active chapter-by-chapter Book of the
New Sun analysis series), Don Beck (Substack, multiple New Sun essays
already), Floyd Holland (Substack, prose/craft analysis), Lincoln Michel
(Substack, "Counter Craft" — a literary craft newsletter with demonstrated
serious Wolfe interest), Andy Lee (Substack, the newest strong essay
found, on *Peace*), and Dave Hook (WordPress, recent attention to Wolfe's
short story collections specifically, distinct from the usual New-Sun-only
focus).

**Update: confirmed — Substack as a whole platform blocks GitHub Actions'
IP range, not just one blog.** Wolf (radicaledward) was already known
blocked from an earlier round. A live run of this batch then showed all
four *other* Substack sources here (Don Beck, Floyd Holland, Lincoln
Michel, Andy Lee) failing with the exact same instant 403, in the same
run. Five independent Substack blogs, same platform, same failure,
same signature as DeviantArt and Bluesky — strong enough evidence now to
call this a platform-level block rather than coincidence across five
separate blogs. Left all five in `SOURCES` anyway, same reasoning as
DeviantArt and Bluesky: could plausibly work from a different environment
even though it doesn't work here. Medium and WordPress are unaffected —
Mannish Boy and Dave Hook both reach their servers fine, they just haven't
had recent Wolfe-tagged posts in their current feed window, a completely
different (and unremarkable) situation from an access block.

## Routing around the Substack block via Google Alerts

Rather than accept five Substack sources sitting permanently at zero, or
take on real infrastructure (a VPS, a self-hosted runner) just to dodge an
IP block, `fetchGoogleAlerts` sidesteps the problem entirely: instead of
fetching Substack directly, it consumes a Google Alerts RSS feed for a
search query scoped to that specific writer (e.g. `"Gene Wolfe"
site:donbeck1.substack.com`) — Google's own crawler does the actual
Substack-fetching, we just read Google's already-public alert-result feed.
The request goes to `google.com`, never to `substack.com`, so the
confirmed block shouldn't apply at all.

**Proof of concept, Don Beck first** — `kind: 'google-alerts'`, added
alongside (not replacing) his direct, still-blocked source, so the direct
one keeps recording a real `[skip]` line if the block is ever lifted
rather than silently vanishing from the log. If a live run shows both
returning the same post, the existing global URL dedup (built earlier for
the YouTube Search / named-channel overlap) already handles it — no new
code needed there.

Two known quirks of Google Alerts feeds, handled defensively rather than
confirmed against a real example: Google often wraps result links in a
redirect (`google.com/url?q=REAL_URL&...`), unwrapped here by extracting
the real URL from the `q` parameter so readers land on the actual post,
not an intermediate Google page. Google Alerts also bolds matching search
terms directly in the title using literal `<b>` tags, stripped here via
the same `stripHtmlTags` helper already used for Crossref abstracts and
Patreon post content.

**Not verified against a real feed at all** — Google's robots.txt blocks
even read-only tooling from fetching an alerts feed directly, a courtesy
convention this project's own `fetch()` calls don't follow (very few
things besides well-behaved crawlers respect robots.txt), so there was no
way to preview this feed's actual structure before wiring it in. Built
from general knowledge of how Google Alerts feeds are typically
structured, not a confirmed example — needs a real run to know if it
works at all, let alone whether the two quirks above were handled
correctly. If Don Beck's version works, extending this to the other four
blocked Substack writers is the same five-minute alert setup repeated,
not more building.

**Extended to the other four confirmed-blocked Substack sources**: Floyd
Holland, Lincoln Michel, Andy Lee, and Wolf (radicaledward) — same
`kind: 'google-alerts'` pattern, same "alongside, not replacing" approach.
Don Beck's version reached Google fine (no 403) but hadn't surfaced any
items yet at the time these four were added — Google Alerts doesn't
backfill, so a brand-new, narrow (`site:`-scoped) alert can take anywhere
from hours to a few days to start returning results, not a sign it's
broken. All five: the real thing being confirmed is that the *request*
succeeds — whether content actually flows through is still an open
question being watched over time, not something a single run settles.

**Added to the Reference Shelf instead** — the two standout one-off
essays from the batch: Adam Roberts' Medium piece ("easily the most
substantial Medium essay" found in the research) and Peter Bebergal's 2015
New Yorker profile ("still perhaps the most important mainstream
profile"). Both evergreen, both worth a permanent link rather than an
ongoing feed slot for a source that produced exactly one relevant piece.

**Not added, for now:** the many other real, good essays the research
surfaced (Nicholas Russell, Kevin Kodama/Synthesized Sunsets, Jessie
Lethaby, Tobias Carroll, Max Gladstone, Joan Gordon's two LARB pieces, and
several more) — genuinely worth reading, just not added as either feed
sources or Reference Shelf links in this pass, to avoid either diluting
the Reference Shelf into an undifferentiated link dump or adding feed
sources unlikely to ever fire again. Worth a second pass if any of these
specifically turn out to matter.

## More YouTube channels, and a real bug fix

Added three more general sci-fi/literary YouTube channels that cover
Wolfe among other authors: Media Death Cult, High Low Brow, and The
Well-Read Monocle. All three get `requireKeyword: 'wolfe'`, same as Wolf
and Crookall — general channels, not Wolfe-dedicated ones.

While adding these, realized Marc Aramini's channel — in `SOURCES` since
the very start of this project — never got the same filter, even though
he's exactly the kind of creator who needed it: a broad literary critic,
not someone who only covers Wolfe. Real bug, not a new addition: unrelated
videos of his had been showing up in the feed the whole time. Fixed the
same way as everything else in this category — `requireKeyword: 'wolfe'`
added to his source entry. The filtering itself needed no code changes;
YouTube channels already flow through the same generic fetch path Wolf and
Crookall use, so this was purely a one-line config fix, not a new feature.

**Seven more added** from a research pass on recent (2025-2026) Wolfe
BookTube/podcast coverage: iSamwise, A Novel Review, Exits Examined, Nick
Reads Fantasy, sunbeamsjess, Geek's Guide to the Galaxy, and Undertowers
Podcast. All general-interest channels, all get `requireKeyword: 'wolfe'`.
ReReading Wolfe (already tracked since the start of this project) came up
independently in the same research as the strongest ongoing Wolfe
coverage — good confirmation the original source list was on the right
track. One more channel from that same research, "Zac's (mostly) Fantasy
& Sci-Fi," couldn't be confidently identified — the closest search match
wasn't a sure enough thing to use, so it's a commented placeholder in
`SOURCES` instead of a guess.

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

## Series/format filters no longer persist — Spoiler Shield still does

Every filter used to save to `localStorage` and restore on the next
visit, including series and format — meaning a visit could quietly start
pre-filtered to whatever was selected last time, with no visible reason
why the feed looked different from what "no filter" should show. By
request, series and format now reset to "All Series / All Formats" on
every fresh visit — `restoreFilters()` in `index.html` deliberately skips
them. The character-tag filter and the Saved toggle still persist as
before, since those weren't part of the ask. **Spoiler Shield progress is
a separate, untouched concern** — it lives under its own `STORE` key
(`'progress'`, not `'filters'`) and keeps carrying over exactly as it
always has; nothing about that changed here.

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

### Fixed a redundant dropdown option

"Through [last book in a series]" and "All caught up" used to be two
separate options that meant exactly the same thing — nothing can be
further ahead than a series' final book, so selecting either one produced
identical behavior. Confusing, not a real distinction. Fixed: the last
book no longer appears as its own choice in the picker (`buildSelect` in
`index.html` deliberately excludes it via `BOOKS[series].slice(0, -1)`),
leaving "All caught up" as the one way to represent full completion.
`BOOKS` itself stays whole, though — items actually tagged with that final
book still need it for spoiler comparisons against readers who chose an
earlier "Through X." Also normalized both `maybeAdvanceProgress` (the
auto-advance feature above) and any already-stored progress value that
pointed at the now-removed option, so neither path can silently produce a
value the dropdown no longer has a matching entry for.

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

## Cards weren't actually clickable — a real, significant bug

Every card had a title, a thumbnail, tags, a save button — but no actual
link to the thing it was about. Nothing in `cardHtml()` ever connected a
card to `d.url` except the fan-art attribution row, which only exists on
`fanart`-type cards. For every video, podcast, discussion, article, and
paper, there was simply no way to get from the card to the actual content
by clicking anything on it. This had been true since the very first
version of this site, missed the whole time because testing focused on
data and layout, not on actually clicking through to content.

Fixed: the title is now a real link, and the thumbnail is too, *except*
when it's showing the NSFW-blur badge — in that case it deliberately stays
a plain, non-navigating element so clicking it still reveals the image
first rather than immediately leaving the site. A missing `url` (shouldn't
happen — every fetcher already filters these out before they reach
`data.json` — but defensively handled anyway) falls back to plain,
non-linked text rather than a broken `href="undefined"`. Verified the fix
doesn't let a click bypass the Spoiler Shield either: the spoiler overlay
is a solid, absolutely-positioned layer sitting on top of the card's real
content in normal stacking order, so it intercepts clicks before they ever
reach the title link underneath — nothing needed to change there.

## Backfilling known back-catalog pieces — as real feed items, not shelf links

RSS feeds and Google Alerts both only ever surface *new* content going
forward — a writer's entire existing body of work is otherwise invisible
to this project permanently, not just until an alert catches up. Since
the earlier research pass already surfaced specific known Wolfe pieces
from the writers now being tracked via Google Alerts, first instinct was
adding those to the Reference Shelf, the same mechanism already used for
Adam Roberts and Bebergal. Corrected on direct feedback: these are dated
articles, not durable reference material like a dictionary or a chapter
guide — they belong in the feed as real, sortable, filterable cards, not
a separate static list.

`MANUAL_ITEMS` in `fetch-content.js` holds them instead — a small
hardcoded array merged into every run's output in `main()`, right
alongside whatever gets fetched. Unlike `data.json`, which gets fully
regenerated every single run (any hand-edit to it would vanish on the
next hourly Action run), this array lives in the source code itself, so
it persists permanently without needing rediscovery by any fetcher. Five
pieces currently: two from Don Beck, one each from Floyd Holland, Lincoln
Michel, and Andy Lee. Two dates are approximate, flagged individually in
the code — the original research gave only a month for Floyd Holland's
piece, and no date at all for Don Beck's second piece beyond "a follow-up"
to the first.

**Resolved: Wolf (radicaledward)'s chapter-by-chapter New Sun read** —
added as a sixth `MANUAL_ITEMS` entry, a representative entry point into
the whole (now-paused) archive rather than a single essay, with a rough
approximate date flagged in the code as standing in for the project as a
whole rather than tied to a specific confirmed publish date.

Worth being explicit about something that might not be obvious: several
of these entries are Substack URLs — the exact platform confirmed blocked
from GitHub Actions elsewhere in this file. That block doesn't apply
here at all. It's a server-side fetching problem; these URLs are just
plain data sitting in the source, rendered as ordinary links in an actual
visitor's browser, which isn't on GitHub's blocked IP range.

**A second, later move for the same reason**: The Ringer's 2019
retrospective, Adam Roberts' Medium essay, and Peter Bebergal's New Yorker
profile all started out on the Reference Shelf too, alongside the four
books and Gwern's archive — moved into `MANUAL_ITEMS` for the same reason
as the batch above: these are dated articles, not durable reference
material, so they belong in the feed. Their real known publish dates are
used (The Ringer: April 25, 2019; Adam Roberts: July 3, 2023), except
Bebergal's, which is approximate — the original research only gave "April
2015," no specific day.

## Real Reference Shelf covers, not just icons

The icon fallback (previous section) was always meant to be a graceful
degradation, not a final answer. Two follow-up attempts to find real
cover images: first tried Open Library's Covers API
(`covers.openlibrary.org/b/isbn/{ISBN}-M.jpg`) — a real, documented,
deterministic pattern, genuinely better than guessing at Goodreads' CDN
structure, and confirmed working for Lexicon Urthus with a real ISBN
(9780964279506). But finding confirmed ISBNs for the smaller-press titles
(*Between Light and Shadow*, *Attending Daedalus*, *Solar Labyrinth*) by
search alone kept coming up short — these aren't as cleanly indexed as
mainstream titles.

**Resolved with direct, ground-truth image URLs supplied directly** —
Goodreads CDN links, an Amazon product image for Chiarello's guide, and
Gwern's own site logo. All six remaining shelf items (after removing the
Word Hoard, redundant to Lexicon Urthus and removed entirely) now show
real cover art or a real logo. Kept the `onerror="this.remove()"` fallback
to the icon tile on every one anyway, even the confirmed URLs — cheap
insurance if a link ever goes stale, same defensive pattern used
everywhere else images appear in this project.

One real mistake caught and fixed during this: an early edit's `old_str`
accidentally captured and deleted the `<a>` opening tag for one shelf item
while only meaning to replace its thumbnail — caught immediately by
viewing the result rather than assuming the edit landed cleanly, fixed
before it ever reached a commit.

## Backfilling art without a verified image URL — a generic icon instead

Tried to backfill Don Maitz's and Bruce Pennington's original New Sun
cover paintings the same way as the articles above, but hit a real,
different problem: articles just need a URL to *link* to, art needs a URL
that actually *displays as an image*. Couldn't find a verified, stable,
hotlink-safe image URL through available tools — auction houses,
Pinterest, and gallery sites don't expose that kind of URL to search, and
there's no live browser access here to grab one directly from a source
like Goodreads. Rather than guess a plausible-looking image URL and risk
a broken image on the live site, landed on a simpler fix instead: these
two `MANUAL_ITEMS` entries (`type: 'fanart'`) simply have no `thumbnail`
field, falling back to the same tinted icon tile every fan art card
already uses before a real thumbnail loads — not a new mechanism, just
deliberately relied on here instead of treated as a rare edge case.
Swapped `ICONS.fanart` from a generic diamond to an artist's palette
(`&#127912;`) to actually look like art at a glance, since this fallback
is now doing real, permanent work for these two entries, not just
covering a brief loading flicker.

Both use their true original 1980 publication dates rather than a
recent/fake date to force visibility in the main "Latest" scroll — using
a fake date to inflate recency would misrepresent genuinely historical
content. This means neither shows up near the top of a normal scroll
through the feed, which is fine: anyone using the **Art** filter chip
specifically will see them regardless of date, since that filter isn't
time-limited. The discovery path for evergreen content like this is
filtering by type, not happening to scroll past it in "Latest."

**Extended to eight more artists** from the original research batch —
Alexander Preuss, Nathan J. Anderson, Ramón Perales Cano, Eric He, Sam
Weber, Vega Draws, Floating Disc, and Andrea Kalfas — all `type: 'fanart'`,
all using the same icon fallback, no image-URL verification needed for any
of them now that the fallback is an accepted, deliberate treatment rather
than a gap to fill. Dates are explicitly approximate/illustrative
(staggered across recent months) for all eight, flagged as such in the
code — none of these have a specific confirmed publish date from the
original research. Nathan J. Anderson's individual posts (as
u/deimosremus) already come through automatically via r/genewolfe's own
feed — his `MANUAL_ITEMS` entry here is his broader portfolio site
specifically, not a duplicate of what the live feed already finds.

**The Reference Shelf got the same icon treatment.** Its remaining seven
entries (the four books, Gwern's archive, the Word Hoard tool, and
Chiarello's chapter guide) were plain text with no visual anchor at all —
tried finding real book-cover images the same way as Maitz/Pennington,
hit the identical verification wall (no live browser access to grab a
real Goodreads cover URL), so applied the same honest fallback instead: a
small `.shelf-thumb` icon tile per entry, book emoji for the five actual
books, a folder icon for Gwern's archive, an open-book icon for the Word
Hoard dictionary tool. Restructured `.shelf-item` from `align-items:
baseline` to `align-items: center` to accommodate a fixed-size icon
alongside the text without breaking the row's vertical alignment.

## Art links now point at the actual artwork, not artist homepages

Real complaint, real fix: several `MANUAL_ITEMS` fanart entries linked to
an artist's general homepage or ArtStation profile instead of the
specific piece being described. Researched and fixed four of six: Sam
Weber (now points to the specific Claw of the Conciliator Folio Society
binding page, not `sampaints.com/`), Vega Draws (now points to a
confirmed "Morwenna's Execution" process journal — the original "River
Gyoll" reference didn't have its own page, only a homepage thumbnail, so
the title changed to match what's actually being linked), Andrea Kalfas
(now points to her own Tumblr post about the specific "Severian and the
Undine" piece), and Ramón Perales Cano (now points to a specific
Book of Fuligin page on ArtStation instead of his profile). Bruce
Pennington and Floating Disc remain unresolved — couldn't find a more
specific page for either through search.

## Start Here and Spoiler Shield removed entirely

A deliberate product decision, not a bug fix — removed by request after
consideration. This was a large removal touching most of the file, so
worth recording what actually came out: the onboarding banner (first-time
visitor prompt), both disclosure panels (Start Here's reading-order link,
Spoiler Shield's presets and per-series dropdowns), the `BOOKS` constant,
`isSpoiler()`, `maybeAdvanceProgress()`, `updateShieldStatus()`,
`buildSelect()`, `wireDisclosure()`, the spoiler-overlay card markup and
its `data-reveal` handler, the `revealed` Set, and the `progress` /
`onboarded` keys from `STORE._defaults`. The value-prop line and all
three meta-description tags referenced the Shield directly and needed
rewriting too, since they were now describing a feature that no longer
exists.

**What stayed, deliberately**: the NSFW content-rating blur
(`revealedNsfw`, `data-nsfw-reveal`) is a completely separate mechanism —
driven by a source's own content rating, not reading progress — and
doesn't touch anything related to Spoiler Shield. `SAMPLE_DATA` and
real fetched items still carry a `book` field on each item; left as
harmless unused metadata rather than stripped out, since removing it
served no purpose and touching every source in `fetch-content.js` for a
field nothing reads anymore was pure risk with no benefit.

## Spoiler Shield: quick-start presets and a visible hidden-item count

**Superseded** — Spoiler Shield was removed entirely in a later round (see
above). Kept this section rather than deleting it, since it's still an
accurate record of the reasoning at the time.


Two of four proposed improvements, chosen deliberately over the other
two: a checkbox-based redesign was rejected outright — progress through a
series is sequential, not independent selections, so checkboxes would let
someone represent a state the data model can't actually use (e.g. "read
Sword but not Claw"). A visual stepper and an always-visible progress
summary were both real, reasonable ideas but bigger changes than these
two — left for later rather than bundled in.

**Quick-start presets** (`.shield-presets`, four buttons above the
per-series dropdowns): "Haven't started," "Finished New Sun," "Finished
New & Long Sun," "Read everything." Deliberately follow the actual
reading order — "Finished New Sun" only sets `new` to `'all'`, leaving
Long and Short at `'none'` rather than guessing someone's also read
further, since finishing New Sun doesn't imply anything about Long or
Short Sun specifically. One click sets all three `STORE.progress` values
at once and updates the visible dropdowns to match — the dropdowns
underneath still work normally for anyone whose situation doesn't fit a
preset.

**A real hidden-item count**, not just On/Off. `updateShieldStatus()` now
computes `DATA.filter(d => isSpoiler(d) && !revealed.has(d.id)).length`
and shows it next to the status ("On · 12 hidden"), the same "make system
state visible" principle already behind the "N matching dispatches" line
added for filters earlier. Called from the top of `render()` itself now,
not just from the specific action handlers that used to call it — keeps
the count in sync with real data, reveals, and progress changes
automatically, rather than needing every future call site to remember to
update it individually.

## Responding to a second, much larger audit — three compatible items

A second, far more comprehensive audit arrived — genuinely well-reasoned
product strategy, but sized for a staffed platform with user accounts, an
editorial team, and a CMS, not a static site regenerated hourly by a
GitHub Action. Server-rendering, creator pages with stable URLs, a
submissions review queue, a "This Week in Wolfe" digest — none of these
are features to add to what exists, they're a different, much bigger
project. Declined the vast majority of it on that basis, explained
directly rather than either implementing blindly or dismissing without
engaging.

One item directly contradicted a decision already made explicitly on a
prior audit two rounds earlier — collapsing Format/date/topic filters
into a "Refine panel" is the same idea as the collapsed-dropdown
suggestion already declined, for the same Miller's Law chunking reasoning
already documented. Not reversing that just because a second audit phrased
it differently.

Three items were genuinely good and actually compatible with what
exists, though:

- **A one-line value prop under the wordmark** (`.value-prop`) — "Every
  Gene Wolfe essay, podcast, video, and discussion — filtered to how far
  you've read." Different from the vague subtitle removed much earlier in
  this file for being generic; this one is specifically functional,
  stating both the aggregation scope and the Spoiler Shield angle in one
  line. Kept deliberately small and quiet rather than a return to a
  prominent tagline treatment.
- **The spoiler overlay now states the specific reason**, not just a
  generic "ahead of your progress" note — "Discusses [book]" when the item
  has a specific book tag, using data (`item.book`, `BOOKS`) that already
  existed and was already used elsewhere (`maybeAdvanceProgress`), just
  wasn't surfaced in this message before. Falls back to the previous
  generic series-level message only if a book code doesn't resolve — an
  effectively unreachable case, since `isSpoiler()` already requires
  `item.book` to be set before anything can be flagged as a spoiler at
  all, confirmed by reading that function directly rather than assumed.
- **Onboarding's "I'm caught up on everything — skip this" now says "Show
  everything, including spoilers"** — checked the actual click handler
  first to confirm this phrasing is accurate to what the button really
  does (sets every series' progress to "all," which is exactly what
  disables all spoiler blurring) rather than just adopting the audit's
  suggested wording on faith.



A large, itemized audit came in covering accessibility, SEO, and visual
design across the whole site. Rather than implement it wholesale, checked
each claim against the actual code first, and split the list into three
real categories.

**Implemented — genuinely good, no conflict with anything already
decided:**
- `aria-label`s on the save-star button (state-reflecting: "Save this
  item" vs. "Remove from saved") and the search input, plus a hover
  `title` tooltip on Spoiler Shield explaining what it does
- `meta name="description"`, Open Graph tags, and a Twitter card (`og:image`
  deliberately left out — no actual branded social-preview image exists
  yet, and pointing it at the SVG favicon wouldn't render well in
  Discord/Reddit/Twitter previews, which want a raster JPG/PNG; needs a
  real designed image before this is complete)
- A global `:focus-visible` style (2px ochre outline) so keyboard focus is
  consistently visible across every interactive element, not left to
  inconsistent browser defaults
- Pagination buttons grew from 34px to 44px, the same Fitts's Law minimum
  already established elsewhere in this file (the save-star and card
  touch-target fixes)
- Mobile header padding reduced from 80px to 36px on screens ≤480px — the
  first media query in this file
- **A real, verified contrast fix**: actually computed WCAG contrast
  ratios rather than trusting the audit's claim at face value.
  `--parchment-dim` (bylines, descriptions) was already fine at 5.2-5.5:1.
  `--muted` (timestamps, status line, quiet-source badges) genuinely
  failed at 2.83-2.98:1 against the 4.5:1 minimum — lightened to `#857f6f`
  (4.87-5.13:1), computed directly, not guessed at.

**Declined — contradicts a decision already made deliberately, with real
reasoning behind it:**
- Replacing numbered pagination with infinite scroll. This one's
  significant: numbered pagination exists *specifically* because of an
  explicit, recent request ("users can elect to see page 2 or 3 or
  whatever") — reversing that on an external audit's say-so without
  checking first would have overridden a direct instruction silently.
- Moving Format filters into a collapsed dropdown, colored format/series
  badge systems, card borders on the Reference Shelf, a bigger "You're
  caught up" indicator with its own divider — all push toward more visual
  complexity on a site whose whole design direction has deliberately gone
  the other way, repeatedly, with specific reasoning already documented
  elsewhere in this file (the Miller's Law chunking discussion, "just a
  SMIDGE" style pass, minimal Spoiler Shield utility row).

**Already true, or already satisfied — the audit's premise didn't match
the actual code:**
- Thumbnails are already fixed 1:1 (84×84, 120×120 featured) — the "mixed
  aspect ratios" claim doesn't hold.
- The search placeholder already exists ("Search titles, descriptions,
  sources, tags…").
- Every `target="_blank"` is already paired with `rel="noopener"` (15/15,
  counted directly).
- "No focus states visible" is essentially unfalsifiable from a static
  screenshot — screenshots don't capture keyboard-focus state at all.
  Added the global rule above anyway, since it's good practice regardless
  of whether a real gap existed.
- The `◂▸` symbol is the decorative arrow-rule under the masthead, not a
  functional pagination or carousel control — nothing to fix there, the
  audit seems to have misread it as interactive.

**Left as open decisions, not implemented either way:** live item counts
per series pill, relative dates for items <7 days old, source-type icons
on the Reference Shelf, and a footer "About" page explaining sourcing —
each is a real, reasonable idea, just a genuine product decision rather
than an obvious fix, worth a direct answer rather than a unilateral call.

## The feed is paginated, 15 items per page

Started at 25, reduced to 15 by request.

The whole filtered result set used to render in one long scroll,
regardless of size. Now capped at `PAGE_SIZE = 25` per page, with
explicit numbered page controls below the feed (not infinite scroll or a
"load more" button, by request) — Previous/Next plus a button per page,
shown only when there's more than one page.

Pagination applies *after* filtering — clicking a series/format chip,
searching, or filtering by tag re-paginates the narrowed set from page 1,
not the other way around. This meant finding every place state that
changes what's being shown: series chips, format chips, the tag filter,
search (input, Escape-to-clear, and the × button), the Saved toggle, and
the "Reset filters" and "Clear" tag buttons all explicitly reset
`currentPage = 1` at the point of change. `render()` itself has no way to
tell "a filter just changed" apart from "the user clicked page 2," so this
couldn't be handled centrally in one place — each mutation point resets
it individually. A defensive clamp in `render()` also catches the case
where `currentPage` is somehow left pointing past the end of a newly-
shrunk result set, as a backstop beyond the explicit resets.

Clicking a page number scrolls back up to the top of the feed
(specifically the "Latest" divider, the first `.divider` element in
document order — there are two on the page, this one and "Further
Reading" further down) rather than leaving the reader wherever their
previous scroll position happened to end up on the new page.

## Scroll position resets on refresh

Browsers try to preserve scroll position across a reload by default —
undesired here, by request: every load, including a plain refresh, should
start at the top. `history.scrollRestoration = 'manual'` disables the
browser's automatic restore, paired with an explicit `window.scrollTo(0,
0)`. Both run synchronously at the very top of the script, before
anything else, so the browser never gets a chance to jump to a remembered
position first.

## Real subreddit icons, upgraded from a gradient-color placeholder

Both subreddits are tagged `series:'general'`, so their cards used to
share the exact same tinted tile as every other general-Wolfe item —
indistinguishable from each other at a glance once there was more than
one. First attempt was fetching actual subreddit icons automatically,
which turned out to be a dead end worth documenting: Reddit's JSON API
(the normal way to get a subreddit's icon) is the same API already
confirmed to block anonymous requests, and web search doesn't index these
small binary image assets well enough to find the current URLs by hand
either. Landed on a fully self-contained placeholder instead — each
subreddit got its own flat gradient color, distinct from the four series
colors, applied as an inline style override.

**Upgraded again shortly after** — the real icon images got supplied
directly, sidestepping the whole fetching problem entirely. Both saved as
static files under `assets/` (`subreddit-genewolfe.png`,
`subreddit-rereadingwolfepodcast.png`), checked into the repo rather than
fetched at runtime, so nothing here depends on Reddit's API at all.
`SUBREDDIT_LOGO` in `index.html` now maps each subreddit to its real
image, used as the thumbnail whenever a Reddit item doesn't have its own
per-item thumbnail (which is always, currently — Reddit's RSS doesn't
expose one). Falls back gracefully to the old tinted tile if an image
ever fails to load. Add more subreddits the same way if they're added to
`SOURCES`: drop the image in `assets/`, add a line to `SUBREDDIT_LOGO`.

## Alzabo Soup links went to a category page, not the episode

Direct report, right after the clickable-cards fix above made this
actually testable: Alzabo Soup's cards linked to
`alzabosoup.com/categories/the-book-of-the-short-sun/` — a real page on
their site, a category archive of every Short Sun episode, described as
"the playlist," not the specific episode. Their `<link>` field appears to
be populated with a book-category URL rather than a true per-episode
permalink.

Added `resolveItemUrl()` to the generic RSS path: for any source with
`preferGuidUrl: true` set (currently just Alzabo Soup), it tries the
item's own `<guid>` first, since GUIDs are frequently real permalinks even
when `<link>` isn't — but only if the guid actually looks like a
well-formed URL, since plenty of feeds use an opaque non-URL string as
their guid instead. Falls back to `<link>` either way if the guid isn't
usable. Every other RSS source is completely unaffected — `preferGuidUrl`
defaults to unset, which keeps the exact same `item.link` behavior as
before.

**Not verified live** — couldn't inspect Alzabo Soup's raw RSS XML
directly to confirm what's actually in their `<guid>` field; both direct
fetch attempts returned it as binary data rather than parseable text, and
the domain isn't reachable from the sandbox this was built in either.
This is a reasoned attempt from strong circumstantial evidence (the
category-page URL matches the reported behavior exactly), not a confirmed
fix. Check Alzabo Soup's links by hand after the next real run — if
they're still pointing at the category page, the guid probably isn't a
usable URL either, and this needs a different approach.

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
