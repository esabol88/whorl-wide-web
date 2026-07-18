/**
 * fetch-content.js
 *
 * Pulls new content about Book of the New/Long/Short Sun from YouTube
 * channels, podcast RSS feeds, the Urth Mailing List (urth.net), Reddit,
 * and DeviantArt, and writes it all to data.json for index.html to display.
 *
 * Each item also gets a thumbnail where the source provides one — YouTube's
 * <media:thumbnail>, a podcast's <itunes:image>, or DeviantArt's
 * <media:content>. Reddit items don't get one; see the comment above
 * fetchRedditRss for why.
 *
 * Fan art is pulled automatically from DeviantArt (real image, real
 * artist attribution, real content rating mapped to the NSFW blur) — see
 * fetchDeviantArt. Reddit can't supply fan art the same way; its RSS
 * doesn't expose the fields needed.
 *
 * Note on Reddit: pulled via its plain RSS export, not the JSON API — as of
 * May 2026 Reddit blocks anonymous requests to the latter, but RSS was
 * still open at time of writing. No registration or API key needed.
 *
 * Run this on a schedule (see the GitHub Actions workflow in
 * .github/workflows/update.yml) — no API keys required for any source
 * configured below.
 *
 * Usage:
 *   npm install
 *   node fetch-content.js
 */

const Parser = require('rss-parser');
const fs = require('fs');
const crypto = require('crypto');

// Fan art detection turned off, 2026 — the heuristics for it (Reddit:
// "does this post have an embedded image," Bluesky: same) can't tell real
// fan art apart from memes, screenshots, or reaction images. r/shittygenewolfe
// especially — it's a joke/meme subreddit by name, and every image post
// there was getting reclassified as "fan art" with nothing to stop it.
// DeviantArt (real image + artist attribution + a real content rating,
// not a blunt "has an image" guess) is unaffected in principle, but it's
// also currently blocked from GitHub Actions anyway (see fetchDeviantArt),
// so this flag being off changes nothing for it right now either way.
// Flip back to true once Reddit/Bluesky detection is actually tightened —
// this suppresses the *output*, not the underlying detection code, so
// nothing needs to be rebuilt to turn it back on.
const FAN_ART_ENABLED = false;

// index.html needs a stable `id` per item (used as the key for saved-item
// stars, spoiler-reveal state, and NSFW-reveal state) — derive one from the
// item's URL so it stays the same across runs instead of being random.
function makeId(sourceName, url) {
  const slug = sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const hash = crypto.createHash('md5').update(url || sourceName).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

// index.html also uses per-item `tags` (clickable character/theme pills) and
// `book` (drives the Spoiler Shield blur). Book-level tagging needs real
// chapter knowledge that RSS text can't reliably give us, so auto-fetched
// items intentionally leave `book` unset — isSpoiler() in index.html treats
// untagged items as spoiler-free by design, same as a "general" item. Tags
// are guessable from title/description text, so we do attempt those.
const CHARACTER_TAGS = {
  Severian: ['severian'],
  Silk: ['silk', 'caldé'],
  Horn: ['horn', "blue's waters", "green's jungles"],
  'the Claw': ['claw of the conciliator', 'the claw'],
  Vodalus: ['vodalus'],
  Dorcas: ['dorcas'],
  Agia: ['agia'],
  Typhon: ['typhon'],
  Hethor: ['hethor'],
  Thecla: ['thecla'],
};

function guessTags(text) {
  const lower = (text || '').toLowerCase();
  return Object.entries(CHARACTER_TAGS)
    .filter(([, words]) => words.some(w => lower.includes(w)))
    .map(([tag]) => tag);
}

// Shared across the rss-parser instance and the two raw fetch() calls this
// file makes directly (Pipermail doesn't have an RSS feed to parse, so it's
// fetched and scraped as plain HTML instead) — see the note on `parser`
// below for why this is a real browser UA rather than a bot-labeled one.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const parser = new Parser({
  timeout: 15000,
  // A realistic browser UA, not a bot-labeled one. A live run against real
  // reddit.com and DeviantArt showed Reddit rate-limiting (429) a burst of
  // simultaneous requests and DeviantArt outright blocking (403) — both
  // classic reactions to traffic that self-identifies as an obvious bot
  // from a datacenter IP (GitHub Actions runners). This won't fix
  // IP-range blocking if that's also happening, but it removes the
  // "looks like a bot" signal, which is often enough on its own.
  headers: { 'User-Agent': USER_AGENT },
  customFields: {
    // YouTube's video RSS nests the thumbnail inside <media:group>.
    // DeviantArt's RSS uses MediaRSS too: <media:content> for the image,
    // <media:rating> for content rating (adult/nonadult).
    item: [
      ['media:group', 'mediaGroup'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:rating', 'mediaRating'],
    ],
  }
});

// ---------------------------------------------------------------------
// CONFIGURE YOUR SOURCES HERE
// ---------------------------------------------------------------------
// series: 'new' | 'long' | 'short' | 'general'
// type:   'video' | 'podcast' | 'discussion' | 'article'
//
// YouTube channel feeds need a channel_id (not a @handle). Find it by
// viewing the channel's page source and searching for "channelId", or
// use a lookup tool like https://commentpicker.com/youtube-channel-id.php
const SOURCES = [
  // --- YouTube channels (free RSS, no key needed) ---
  {
    name: 'Rereading Wolfe',
    type: 'video',
    series: 'new',
    kind: 'youtube',
    channelId: 'UCnS-xbh0apvPFN75Mft0nZQ'
  },
  {
    // Aramini covers a wide range of literary criticism, not just Wolfe —
    // requireKeyword scopes this to his actual Wolfe content, same fix as
    // Wolf (radicaledward) and Martin Crookall further down, for the same
    // reason: a general-subject creator whose channel/blog isn't
    // exclusively about Wolfe.
    name: 'Marc Aramini',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UC8H8yTqvudLIUJphj5M6yvQ',
    requireKeyword: 'wolfe'
  },
  // Three more general sci-fi/literary channels that cover Wolfe among
  // many other authors — same requireKeyword scoping as Aramini above.
  // Filtering happens against every item YouTube's feed returns (~15,
  // not just the 8 we keep), so an infrequent Wolfe video isn't missed
  // just because a high-upload-volume channel posted about other things
  // more recently.
  {
    name: 'Media Death Cult',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UChWX1yxVym2kNXMBD1oKo8Q',
    requireKeyword: 'wolfe'
  },
  {
    name: 'High Low Brow',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCBOI_J6_0lW8MWX1DWm0n3A',
    requireKeyword: 'wolfe'
  },
  {
    name: 'The Well-Read Monocle',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCR8u7-uACB3xP_KQHPbNtcw',
    requireKeyword: 'wolfe'
  },
  // Seven more, found via a research pass on recent (2025-2026) Wolfe
  // BookTube/podcast coverage — all general-interest, none Wolfe-
  // dedicated, so all get the same requireKeyword scoping. Each
  // channel ID was individually confirmed (not guessed) against a real
  // channel page or its RSS feed URL.
  {
    name: 'iSamwise',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCyAsfm99u0OlW74ipH_KhyA',
    requireKeyword: 'wolfe'
  },
  {
    name: 'A Novel Review',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCRQzE_T2r6qPR_jbZNgZC1Q',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Exits Examined',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UC5gmH9jjdUUTGHVl-Qp4BbQ',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Nick Reads Fantasy',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCBqInCqKho9lWLKJmZqq0sw',
    requireKeyword: 'wolfe'
  },
  {
    name: 'sunbeamsjess',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCV9f9VrkwR-EX9gtYHe11Tw',
    requireKeyword: 'wolfe'
  },
  {
    name: "Geek's Guide to the Galaxy",
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCLu3HWCPWiQbOktcPSlKRyg',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Undertowers Podcast',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UCJSfKVXHgSwM0gfnf2WgSPw',
    requireKeyword: 'wolfe'
  },
  // "Zac's (mostly) Fantasy & Sci-Fi" was also flagged by the same
  // research pass, but I couldn't confirm a real channel ID for it —
  // closest search match ("Mostly Scifi") isn't a confident enough
  // match to use. Add it by hand if you have the actual channel URL:
  // {
  //   name: "Zac's (mostly) Fantasy & Sci-Fi",
  //   type: 'video',
  //   series: 'general',
  //   kind: 'youtube',
  //   channelId: 'PUT_THE_REAL_ID_HERE',
  //   requireKeyword: 'wolfe'
  // },

  // --- YouTube search (sweeps all of YouTube, not just named channels) ---
  // See fetchYouTubeSearch above for how this works and the quota math.
  // Needs YOUTUBE_API_KEY set — see README for the Google Cloud Console
  // setup. Gracefully skips (doesn't break the run) if it's not set.
  {
    name: 'YouTube Search',
    type: 'video',
    series: 'general',
    kind: 'youtube-search',
    query: 'Gene Wolfe'
  },

  // --- Podcast RSS feeds (direct feed URL from the podcast's own site or Podcast Index) ---
  {
    name: 'Alzabo Soup',
    type: 'podcast',
    series: 'general',
    kind: 'rss',
    url: 'https://alzabosoup.libsyn.com/rss' // confirmed live — Libsyn-hosted feed
  },

  // --- Scholarly papers (Crossref) ---
  // Crossref is the DOI registration agency most academic publishers use —
  // free, no API key, no signup (https://api.crossref.org). It indexes
  // metadata (title, authors, journal, date, DOI landing-page URL) across
  // virtually every field, not just STEM, which is why it's used here
  // instead of something like the Semantic Scholar API — that one's
  // excellent but skews hard toward CS/AI coverage, and literary
  // scholarship on Wolfe is much more likely to turn up in Crossref via
  // journals like Extrapolation or Science Fiction Studies.
  //
  // The URL Crossref returns is the DOI landing page, which is very often
  // paywalled (a university press or journal's own paper page) — that's
  // expected and fine here: the goal is to surface *that a paper exists*,
  // same as a citation would, not to guarantee free full-text access.
  //
  // CONFIRMED LIVE, then confirmed broken in a specific way: the
  // connection works, but query.bibliographic turned out to be too fuzzy
  // to trust — a real run returned a feed full of unrelated genetics
  // papers ("Gene Expression," "IL13 and IL18 Gene," etc.), because
  // Crossref has no exact-phrase support (confirmed against their own
  // issue tracker) and was matching on the common word "gene" alone.
  // Fixed in fetchCrossref below: fetch a much wider candidate pool, then
  // hard-filter to results that actually contain "wolfe" in the title or
  // abstract — a far rarer, more specific token than "gene," which is
  // what actually enforces relevance here, not the query itself. Tradeoff
  // worth knowing: a genuine Wolfe paper whose title/abstract never
  // literally says "Wolfe" would get filtered out too. That's an
  // acceptable trade — a missed real paper is a much smaller problem than
  // a feed full of unrelated genetics research.
  {
    name: 'Crossref (scholarly papers)',
    type: 'paper',
    series: 'general',
    kind: 'crossref'
  },

  // --- Patreon (specific tracked creators — see fetchPatreon above) ---
  // Empty by default — add creators you specifically want tracked, one
  // line each. Each needs the creator's numeric Patreon ID, not their
  // username; there's no simple username-to-ID lookup, it has to come
  // from viewing the creator's actual Patreon page. Two ways to find it:
  //   1. View page source on their Patreon page, search for
  //      "https://www.patreon.com/api/user/" — the number right after it
  //      is the ID.
  //   2. On their page, open the browser console and type:
  //      patreon.bootstrap.campaign.data.relationships.creator.data.id
  // Example shape once you have one (Rereading Wolfe is the obvious first
  // candidate given the Start Here reading-order link elsewhere on this
  // site, but I don't have their numeric ID — it isn't something search
  // engines index, has to come from the steps above):
  // {
  //   name: 'Rereading Wolfe (Patreon)',
  //   type: 'article',
  //   series: 'general',
  //   kind: 'patreon',
  //   creatorId: 'PUT_THE_NUMERIC_ID_HERE'
  // },

  // --- Urth Mailing List (urth.net) ---
  // No RSS feed exists (it runs on Mailman/Pipermail, ~25 years old, never
  // added one) — handled by fetchPipermail below, which reads the current
  // month's thread-index page instead. Dates are approximate (see comment
  // on fetchPipermail) since getting exact ones would mean fetching every
  // individual message page.
  {
    name: 'Urth Mailing List',
    type: 'discussion',
    series: 'general',
    kind: 'pipermail'
  },

  // --- Reddit, via its plain RSS feed (no auth needed) ---
  // Reddit blocks anonymous requests to its .json API (see the comment on
  // fetchRedditRss below), but the plain .rss export — same content as
  // visiting the subreddit in a browser — was still open as of this
  // writing. Reddit has flagged RSS as something it may lock down next, so
  // if these sources start failing later, that's likely why.
  //
  // No thumbnail or author is pulled — Reddit's RSS doesn't expose either
  // as a usable field (confirmed against a working implementation, not
  // guessed), so this can't be an automated fan-art source. Fan art comes
  // from DeviantArt instead — see below.
  //
  // SUBREDDIT NAMES: all confirmed live via real runs against reddit.com.
  // For Rereading Wolfe's subreddit specifically, "rereadingwolfepodcast"
  // is used rather than the originally-requested "rereadingwolfe" — that's
  // the name their own Apple Podcasts page lists. r/alzabosoup was also
  // requested but confirmed NOT to exist (visited directly — page not
  // found), so it's not in the list below; if that podcast starts a
  // subreddit later, add it the same way as the others.
  //
  // STAGGERED, NOT PARALLEL: firing all Reddit requests via Promise.all
  // simultaneously got most of them rate-limited (429). Real runs showed
  // Reddit's rate-limit window is roughly a minute — a request delayed 60s+
  // from the first one succeeds; delayed 20-40s, it doesn't. So each Reddit
  // source waits an increasing delay (redditDelayMs, 65s apart) before its
  // request fires — see fetchRedditRss below, which awaits it. This is why
  // fetching every source takes a few minutes rather than a few seconds;
  // that's expected, not a hang (see README.md for the full story on how
  // an actual hang was diagnosed and fixed separately from this).
  //
  // TOP, NOT EVERYTHING: this deliberately uses each subreddit's /top/.rss
  // (with a time window) instead of the bare /.rss feed. Reddit's plain RSS
  // never exposes the actual score number — that's still true — but /top/
  // is sorted using Reddit's own real vote data server-side before it ever
  // reaches us, so the *ranking* itself is a genuine engagement signal even
  // though we never see the raw count. Practically: bare /.rss pulls
  // whatever's merely recent; /top/.rss?t=month pulls whatever actually
  // stood out relative to everything else posted that month. `topWindow`
  // below is the time filter (hour/day/week/month/year/all) — month is a
  // reasonable default for a niche fandom subreddit that doesn't post
  // often enough for "week" to reliably surface anything.
  ...[
    { name: 'r/genewolfe', subreddit: 'genewolfe' },
    { name: 'r/rereadingwolfepodcast', subreddit: 'rereadingwolfepodcast' },
    // Add more the same way — one line each:
    // { name: 'r/subredditname', subreddit: 'subredditname' },
  ].map(({ name, subreddit }, i) => ({
    name,
    type: 'discussion',
    series: 'general',
    kind: 'reddit-rss',
    url: `https://www.reddit.com/r/${subreddit}/top/.rss?t=month`,
    redditDelayMs: i * 65000
  })),

  // --- DeviantArt (fan art, no auth needed) ---
  // DeviantArt's RSS backend (backend.deviantart.com/rss.xml) is a public,
  // syndication-intended endpoint — search results as RSS, no login. Unlike
  // Reddit's RSS, this actually gives real usable fields: an image URL, a
  // content rating (adult/nonadult, mapped straight to the NSFW blur), and
  // the artist's username parsed out of the deviation URL for attribution.
  // See fetchDeviantArt below.
  {
    name: 'DeviantArt',
    type: 'fanart',
    series: 'general',
    kind: 'deviantart',
    url: 'https://backend.deviantart.com/rss.xml?q=%22gene+wolfe%22&type=deviation'
  },

  // --- Bluesky (fan art) ---
  // Unlike Tumblr/ArtStation below, Bluesky's public search API
  // (public.api.bsky.app) genuinely searches *all* of Bluesky, not just
  // one account — no login needed for this endpoint. But it searches
  // *posts*, not art specifically, so this is much noisier than
  // DeviantArt: most "Gene Wolfe" posts with an image attached are a book
  // cover photo, a meme, or a screenshotted quote, not fan art. The image-
  // embed filter in fetchBlueskyArt below is the only thing keeping this
  // to actual pictures at all — there's no reliable way to filter further
  // to "this specific image is fan art" from the API alone. Tune `query`
  // if it's pulling too much noise or missing things.
  {
    name: 'Bluesky',
    type: 'fanart',
    series: 'general',
    kind: 'bluesky',
    query: '"Gene Wolfe" art'
  },

  // --- Tumblr (fan art) — only works per-blog, not sitewide ---
  // Tumblr's tag RSS (blogname.tumblr.com/tagged/TAG/rss) still works, but
  // there's no sitewide "search all of Tumblr for this tag" feed the way
  // DeviantArt has — only a specific blog's posts under that tag. Worth
  // adding if you find a specific active Wolfe-fan-art Tumblr blog; not
  // worth guessing at one. Example shape if you do:
  // {
  //   name: 'Some Wolfe Art Blog',
  //   type: 'fanart',
  //   series: 'general',
  //   kind: 'rss',
  //   url: 'https://someblog.tumblr.com/tagged/gene-wolfe/rss'
  // },

  // --- ArtStation (fan art) — same limitation as Tumblr: per-artist only ---
  // ArtStation supports RSS, but only for one artist's portfolio at a time
  // (username.artstation.com/rss) — ArtStation's own team has said a
  // sitewide search/trending feed doesn't work well as RSS, so there isn't
  // one. Worth adding if you know a specific Wolfe fan artist active there:
  // {
  //   name: 'Some Artist (ArtStation)',
  //   type: 'fanart',
  //   series: 'general',
  //   kind: 'rss',
  //   url: 'https://username.artstation.com/rss'
  // },

  // --- INPRNT: not includable ---
  // I couldn't find any evidence INPRNT offers RSS or a public search feed
  // at all — no sitewide, no per-artist. It also looks like a modern
  // JavaScript-rendered storefront, so even basic scraping likely wouldn't
  // see real content without running an actual browser (a much heavier
  // tool than anything else in this file). Not included.

  // --- "Wolf" by radicaledward (Substack) ---
  // Not a dedicated Wolfe blog — it's a general personal newsletter
  // (games, a parenting podcast, serialized fiction, thousands of
  // subscribers) that happened to run a chapter-by-chapter Book of the
  // New Sun read as one section, now on hiatus. Rather than exclude it
  // for being general-interest, requireKeyword scopes it down to just the
  // posts that actually mention Wolfe — same fix as Crossref's "must
  // contain 'wolfe'" filter, applied here via the generic mechanism above
  // instead of a one-off.
  //
  // CONFIRMED BLOCKED on a live run: 403 in ~0.4s, the same near-instant
  // signature as DeviantArt and Bluesky — a third platform now pointing
  // at the same root cause, GitHub Actions' shared IP pool being blocked
  // outright rather than anything fixable from this file. Left in rather
  // than removed, same reasoning as the other two: could plausibly work
  // from a different environment even though it doesn't work here.
  {
    name: 'Wolf (radicaledward)',
    type: 'article',
    series: 'new',
    kind: 'rss',
    url: 'https://radicaledward.substack.com/feed',
    requireKeyword: 'wolfe'
  },

  // --- Ultan's Library (ultan.org.uk) ---
  // A WordPress-based site wholly dedicated to Wolfe scholarship since
  // 2000, edited by Jonathan Laidlow and Nigel Price — essays, reviews,
  // bibliographical info, occasional news. CONFIRMED LIVE — succeeded on
  // a real run.
  {
    name: "Ultan's Library",
    type: 'article',
    series: 'new', // most of the archive is New Sun-focused, though it does cover the wider Urth Cycle
    kind: 'rss',
    url: 'https://ultan.org.uk/feed/'
  },

  // --- Reactor (reactormag.com, formerly Tor.com) — Gene Wolfe tag ---
  // Reactor is a major, professional SFF outlet — pulling their whole
  // front-page feed would be almost entirely non-Wolfe content, so this
  // uses their Gene Wolfe tag archive specifically
  // (reactormag.com/tag/gene-wolfe/), which is real editorial coverage by
  // named critics (Brian Evenson, Fabio Fernandes, and others), not
  // reader-submitted content. CONFIRMED LIVE — succeeded on a real run.
  {
    name: 'Reactor',
    type: 'article',
    series: 'new',
    kind: 'rss',
    url: 'https://reactormag.com/tag/gene-wolfe/feed/'
  },

  // --- Martin Crookall's blog ---
  // Real, substantial Wolfe coverage over the years, but the blog spans
  // many subjects. Originally thought this needed a Gene-Wolfe-specific
  // tag URL the way Reactor did — but requireKeyword makes that
  // unnecessary: same fix as Wolf above, applied to the blog's plain feed
  // instead of hunting for a tag archive that may not even exist.
  // CONFIRMED LIVE — succeeded on a real run.
  {
    name: 'Martin Crookall',
    type: 'article',
    series: 'general',
    kind: 'rss',
    url: 'https://mbc1955.wordpress.com/feed/',
    requireKeyword: 'wolfe'
  },

  // --- Michael Andre-Driussi's Goodreads author blog — promising, unconfirmed ---
  // Andre-Driussi (Lexicon Urthus — already on the Reference Shelf) is
  // actively posting real Wolfe analysis here as recently as this year,
  // tagged "gene-wolfe" and "book-of-the-new-sun" — genuinely exciting
  // find. But I could not confirm Goodreads exposes RSS for an
  // individual author's blog specifically (their per-shelf book RSS is
  // real and well-documented; their blog/"News" RSS is a different,
  // murkier feature — one direct account from someone who looked into
  // this exact question says Goodreads' own blog section has no RSS at
  // all). Not confident enough to wire in a guessed URL. Worth checking
  // by hand: visit https://www.goodreads.com/author/show/52075 and look
  // for an RSS link on the blog tab; if one exists, it's a strong add.

  // --- Any other blog/site with an RSS feed ---
  // {
  //   name: 'Some Wolfe Blog',
  //   type: 'article',
  //   series: 'new',
  //   kind: 'rss',
  //   url: 'https://example.com/feed'
  // },
];

function youtubeFeedUrl(channelId) {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

// Very light keyword tagging so a general channel's unrelated uploads
// don't flood a Wolfe-specific dispatch. Adjust freely.
const KEYWORDS = {
  new: ['new sun', 'severian', 'shadow of the torturer', 'claw of the conciliator',
        'sword of the lictor', 'citadel of the autarch', 'urth of the new sun'],
  long: ['long sun', 'silk', 'nightside', 'lake of the long sun', 'caldé of the long sun',
         'exodus from the long sun', 'whorl'],
  short: ['short sun', 'horn', 'on blue', 'in green', 'return to the whorl'],
};

function guessSeries(text, fallback) {
  const lower = text.toLowerCase();
  for (const [series, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => lower.includes(w))) return series;
  }
  return fallback;
}

// ---------------------------------------------------------------------
// REDDIT (via RSS, no auth)
// ---------------------------------------------------------------------
// Reddit's .json API now requires authentication (see the conversation this
// script came from), but its plain RSS export — same content as visiting
// the subreddit URL in a browser — was still open to anonymous requests as
// of this writing. This uses the exact same rss-parser instance and fields
// as every other RSS source in this file: title, link, publish date, and
// contentSnippet. No thumbnail, author, or vote data — Reddit's RSS doesn't
// expose any of that as a usable field, so there's nothing to fake here.
function delay(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

// Reddit's RSS entries carry a rendered HTML snippet per post (rss-parser
// exposes it as item.content, separate from the plain-text
// item.contentSnippet) — for link/image posts, that snippet embeds an
// <img> thumbnail. Extracting it is how this tells "someone posted a
// picture" apart from "someone posted a text discussion," using the same
// RSS feed for both rather than needing a separate art-specific source.
//
// NOT VERIFIED LIVE — I can't reach reddit.com from the sandbox this was
// built in, so this is built from the documented/observed shape of
// Reddit's RSS output, not a real test run. Check the first live run:
// does the Fan Art filter actually show real images pulled from Reddit,
// or does nothing show up (meaning the <img> extraction didn't match)?
function extractRedditThumbnail(html) {
  const match = (html || '').match(/<img[^>]+src="([^"]+)"/i);
  return match ? match[1].replace(/&amp;/g, '&') : null;
}

// Re-examining the "Reddit's RSS has no author field" claim rather than
// taking it as settled — it was inherited from the original project
// handoff, not verified firsthand. Reddit's feed is Atom, and Atom
// entries commonly carry <author><name>/u/username</name></author>,
// which rss-parser normalizes into item.creator by default; this was
// simply never checked before. Two independent signals, tried in order:
//   1. item.creator — the structured field, if Reddit actually populates it.
//   2. A "submitted by /u/username" pattern in the same embedded content
//      HTML already used for thumbnail extraction — Reddit's rendered
//      snippet typically includes this as visible text.
// Falls back to null (→ "Unknown artist") only if neither is present.
//
// NOT VERIFIED LIVE — same caveat as everything else Reddit-related built
// in this sandbox: can't reach reddit.com to confirm which signal (if
// either) actually fires. Check the next live run's Fan Art cards for
// real usernames instead of "Unknown artist."
function extractRedditAuthor(item) {
  const creator = (item.creator || item.author || '').replace(/^\/?u\//, '').trim();
  if (creator) return creator;
  const match = (item.content || '').match(/\/u\/([\w-]+)/);
  return match ? match[1] : null;
}

// Reddit's RSS gives no structured content-rating field the way
// DeviantArt's media:rating does — this is a weak, best-effort fallback:
// flag as NSFW only if the post visibly self-labels as such in its own
// title. This WILL miss real NSFW content that isn't self-tagged; it's
// not a substitute for a real rating field, because Reddit's RSS simply
// doesn't have one to check. Worth specifically watching once this is
// live, given what's at stake if it under-flags something.
function redditTitleNsfw(title) {
  return /\bnsfw\b/i.test(title || '');
}

async function fetchRedditRss(source) {
  try {
    if (source.redditDelayMs) await delay(source.redditDelayMs);
    const feed = await parser.parseURL(source.url);
    // 6, not 15 — /top/.rss already filters for quality, but capping the
    // count too keeps a niche subreddit's whole month of "top" posts from
    // still outnumbering every other source in the feed by sheer volume.
    return feed.items.slice(0, 6).map(item => {
      const title = (item.title || 'Untitled').trim();
      const thumbnail = extractRedditThumbnail(item.content);
      const isArt = FAN_ART_ENABLED && !!thumbnail;
      const author = isArt ? extractRedditAuthor(item) : null;
      return {
        id: makeId(source.name, item.link),
        title,
        source: source.name,
        type: isArt ? 'fanart' : source.type,
        series: guessSeries(title, source.series),
        date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
        url: item.link,
        desc: (item.contentSnippet || '').slice(0, 220),
        tags: guessTags(`${title} ${item.contentSnippet || ''}`),
        thumbnail,
        ...(isArt ? {
          artist: author ? `u/${author} (Reddit)` : 'Unknown artist (via Reddit)',
          artistUrl: author ? `https://www.reddit.com/user/${author}` : null,
          postUrl: item.link,
          nsfw: redditTitleNsfw(title)
        } : {})
      };
    });
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------
// DEVIANTART (fan art)
// ---------------------------------------------------------------------
// backend.deviantart.com/rss.xml is DeviantArt's public search-as-RSS
// endpoint — pass a query via ?q= and it returns matching deviations, no
// account or API key needed. Each entry carries real structured data
// (unlike Reddit's RSS): a media:content image URL, a media:rating of
// "adult" or "nonadult", and the artist's username is embedded in the
// deviation URL itself (deviantart.com/USERNAME/art/...).
function extractDeviantArtUsername(link) {
  const match = (link || '').match(/deviantart\.com\/([^/]+)\//i);
  return match ? match[1] : null;
}

async function fetchDeviantArt(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 15).map(item => {
      const username = extractDeviantArtUsername(item.link);
      const thumbnail = item.mediaContent?.[0]?.$?.url || null;
      const rating = (item.mediaRating || '').toString().toLowerCase();
      return {
        id: makeId(source.name, item.link),
        title: (item.title || 'Untitled').trim(),
        source: source.name,
        type: 'fanart',
        series: guessSeries(item.title || '', source.series),
        date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
        url: item.link,
        desc: (item.contentSnippet || '').slice(0, 220),
        tags: guessTags(`${item.title || ''} ${item.contentSnippet || ''}`),
        thumbnail,
        artist: username ? `${username} (DeviantArt)` : 'Unknown artist',
        artistUrl: username ? `https://www.deviantart.com/${username}` : null,
        postUrl: item.link,
        nsfw: rating.includes('adult')
      };
    });
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------
// BLUESKY (fan art)
// ---------------------------------------------------------------------
// public.api.bsky.app is Bluesky's public AppView — app.bsky.feed.searchPosts
// works unauthenticated for basic queries (confirmed against the AT
// Protocol's own lexicon docs). Filtered hard to posts with an image
// embed (post.embed.images), since this searches all posts, not art
// specifically — see the comment in SOURCES above for why that still
// leaves real noise (book photos, memes, quote screenshots) that
// DeviantArt's dedicated art search doesn't have to deal with.
//
// CONFIRMED LIVE: blocked. A real run got `403` in ~0.2s — the identical
// signature to DeviantArt's failure (near-instant, not a rate-limit-style
// delay after a wait). That points at the same root cause: GitHub Actions'
// shared IP pool being blocked outright by Bluesky's API, same as
// DeviantArt, not something fixable via headers or pacing. Left in rather
// than removed, same reasoning as DeviantArt — this could plausibly work
// from a different environment (e.g. a self-hosted runner) even though it
// doesn't work here.
function blueskyNsfw(post) {
  const NSFW_LABELS = ['porn', 'sexual', 'nudity', 'graphic-media'];
  return (post.labels || []).some(l => NSFW_LABELS.includes((l.val || '').toLowerCase()));
}

async function fetchBlueskyArt(source) {
  try {
    const url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?' + new URLSearchParams({
      q: source.query,
      sort: 'latest',
      limit: '30'
    });
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.posts || [])
      .filter(p => p.embed?.images?.length) // fan art only — drop text-only matches
      .slice(0, 15)
      .map(p => {
        const rkey = (p.uri || '').split('/').pop();
        const handle = p.author?.handle || 'unknown';
        const postUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;
        const text = p.record?.text || '';
        return {
          id: makeId(source.name, p.uri),
          title: text.slice(0, 100) || 'Untitled post',
          source: source.name,
          type: 'fanart',
          series: guessSeries(text, source.series),
          date: (p.record?.createdAt || p.indexedAt || new Date().toISOString()).slice(0, 10),
          url: postUrl,
          desc: text.slice(0, 220),
          tags: guessTags(text),
          thumbnail: p.embed.images[0]?.thumb || null,
          artist: `${p.author?.displayName || handle} (Bluesky)`,
          artistUrl: `https://bsky.app/profile/${handle}`,
          postUrl,
          nsfw: blueskyNsfw(p)
        };
      });
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------
// CROSSREF (scholarly papers)
// ---------------------------------------------------------------------
// Crossref's REST API (api.crossref.org) is free, keyless JSON — no RSS
// involved, so this doesn't go through the shared rss-parser instance.
// query.bibliographic does a fuzzy match across title/author/etc rather
// than full text, so an occasional false positive (an unrelated "Gene" or
// "Wolfe" match) is possible; that's an acceptable tradeoff for a feed a
// person skims rather than something driving automated decisions.
//
// Crossref abstracts, when present, come wrapped in JATS XML tags
// (<jats:p>...</jats:p>) rather than plain text. Generic enough (just a
// tag-stripper) that it's reused for Patreon's HTML post content below too.
function stripHtmlTags(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Crossref dates are a { 'date-parts': [[year, month, day]] } structure,
// and month/day are frequently missing on older or print-only records —
// pad those down to '01' so every item still gets a valid YYYY-MM-DD for
// sorting and display, even though the true day is unknown.
function crossrefDate(work) {
  const parts = (work.published || work['published-online'] || work['published-print'] || work.created)?.['date-parts']?.[0];
  if (!parts) return new Date().toISOString().slice(0, 10);
  const [y, m, d] = parts;
  return `${y}-${String(m || 1).padStart(2, '0')}-${String(d || 1).padStart(2, '0')}`;
}

async function fetchCrossref(source) {
  try {
    const url = 'https://api.crossref.org/works?' + new URLSearchParams({
      'query.bibliographic': 'Gene Wolfe',
      filter: 'type:journal-article',
      rows: '50' // fetch a wide pool — query.bibliographic is fuzzy/tokenized (Crossref
                 // has confirmed no exact-phrase support), so most candidates get filtered
                 // out below; 15 wasn't enough of a pool to reliably find real matches in
      // No `sort` param here — deliberately left at Crossref's default
      // (relevance to the query). Two consecutive live runs showed why:
      // sorting the *candidate pool* by published-date-desc pulled in
      // whatever's most recently published across ALL fields matching
      // "gene" loosely — dominated by high-volume unrelated research like
      // genetics — which pushed genuinely Wolfe-relevant papers (published
      // far less often) out of the 50-item window entirely. One run
      // returned a full batch of 15; the very next returned zero, same
      // query, same code, just different papers happened to be freshly
      // published that week. Relevance-sorting the candidate pool fixes
      // this — date-sorting happens below, only among items that actually
      // survived the wolfe-content filter.
    });
    // Crossref explicitly asks identifying requests be sent to their
    // "polite pool" for better reliability — the opposite ask from
    // Reddit/DeviantArt, which is why this uses its own descriptive UA
    // rather than the shared browser one. Add &mailto=you@example.com to
    // the query above if you want the full polite-pool priority.
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Fuligin/1.0 (Gene Wolfe fan content aggregator; https://github.com/)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.message?.items || [])
      .map(work => {
        const title = (work.title?.[0] || 'Untitled').trim();
        const authors = (work.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
        const journal = work['container-title']?.[0] || null;
        const abstract = stripHtmlTags(work.abstract).slice(0, 220);
        const byline = authors.length ? `By ${authors.join(', ')}${journal ? ` — ${journal}` : ''}` : (journal || '');
        return {
          id: makeId(source.name, work.URL || work.DOI),
          title,
          source: journal || source.name,
          type: 'paper',
          series: guessSeries(`${title} ${abstract}`, source.series),
          date: crossrefDate(work),
          url: work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : null),
          desc: abstract || byline,
          tags: guessTags(`${title} ${abstract}`),
          _searchText: `${title} ${abstract}`.toLowerCase() // used for the filter below, not kept on the final item
        };
      })
      // The real filter: query.bibliographic being fuzzy means a plain
      // "Gene Wolfe" search ranks any paper containing the common word
      // "gene" (genetics, gene expression, etc.) as a loose match even
      // with zero connection to the author — confirmed live, this was
      // returning entirely unrelated medical/genetics papers. "Wolfe" is
      // a far rarer token, so requiring it specifically is what actually
      // enforces relevance here, not the query itself.
      .filter(item => item._searchText.includes('wolfe') && item.url)
      .sort((a, b) => b.date.localeCompare(a.date)) // recency among real matches only, now that relevance already picked the candidate pool
      .slice(0, 15)
      .map(({ _searchText, ...item }) => item);
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------
// PATREON (specific tracked creators — not a sitewide search)
// ---------------------------------------------------------------------
// Patreon has no official public feed for a creator's general posts — its
// "Public RSS" feature is opt-in, per-creator, and audio-podcast-episodes
// only, so it wouldn't cover a text/announcement post even if a creator
// enabled it. This instead uses the same undocumented internal API
// Patreon's own website calls to load a creator's page — reverse-
// engineered by a few open-source projects (patreon-rss, patreon-feed),
// not something Patreon publishes or supports for third parties. This is
// meaningfully more fragile than every other source in this file: no
// stability guarantee, could change shape or get blocked without notice,
// the way an officially-documented API wouldn't. Scoped deliberately to a
// fixed list of creators by numeric ID (see SOURCES below), not a
// sitewide search — Patreon doesn't offer sitewide search via this API
// even if we wanted it.
//
// Paid/members-only posts still come through with a title and link even
// without auth — their `content` is typically empty, handled below by
// falling back to a "members-only" note rather than a blank card, same
// spirit as Crossref surfacing a paywalled DOI link.
//
// NOT VERIFIED LIVE — I can't reach api.patreon.com from the sandbox this
// was built in. Built from a real, working open-source implementation's
// source code, not a guess, but still needs a real run to confirm.
async function fetchPatreon(source) {
  try {
    const fields = {
      post: ['title', 'content', 'published_at', 'url', 'is_paid'],
      user: ['full_name', 'url']
    };
    const params = new URLSearchParams({ 'json-api-version': '1.0' });
    Object.entries(fields).forEach(([type, list]) => params.append(`fields[${type}]`, list.join(',')));
    params.append('filter[is_by_creator]', 'true');
    params.append('filter[is_following]', 'false');
    params.append('filter[creator_id]', source.creatorId);
    params.append('filter[contains_exclusive_posts]', 'true');
    params.append('page[cursor]', 'null');

    const res = await fetch(`https://api.patreon.com/stream?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data || []).slice(0, 10).map(item => {
      const a = item.attributes || {};
      const title = (a.title || 'Untitled post').trim();
      const content = stripHtmlTags(a.content);
      const desc = content
        ? content.slice(0, 220)
        : (a.is_paid ? 'Members-only post — view on Patreon for the full text.' : '');
      return {
        id: makeId(source.name, a.url),
        title,
        source: source.name,
        type: 'article',
        series: guessSeries(`${title} ${content}`, source.series),
        date: (a.published_at || new Date().toISOString()).slice(0, 10),
        url: a.url || null,
        desc,
        tags: guessTags(`${title} ${content}`)
      };
    }).filter(item => item.url);
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------
// YOUTUBE SEARCH (sweeps all of YouTube, not just named channels)
// ---------------------------------------------------------------------
// Everything else YouTube-related in this file pulls from a fixed list of
// named channels — real, but it only ever finds what's already been
// manually added. This uses YouTube's official Data API v3 search.list
// endpoint to search *all* of YouTube for recent uploads matching a query,
// catching creators nobody thought to add by hand. Needs a free API key
// (see README for the two-minute Google Cloud Console setup) — gracefully
// skips with a clear message if YOUTUBE_API_KEY isn't set, rather than
// failing the whole run.
//
// Quota: search.list costs 100 units per call regardless of result count,
// against a free daily quota of 10,000 units (100 calls/day). Running
// hourly, one query per run costs 2,400/day — comfortable headroom even
// with the occasional retry. publishedAfter is set to a rolling 7-day
// window rather than searching all-time on every run: keeps each call
// small and fast, and the overlap between runs (this ran an hour ago too)
// means a missed run or two doesn't lose anything.
//
// Real semantic search (not a fuzzy bibliographic match like Crossref
// had), so noise should be much lower — but title/description still get
// the same "does it actually say wolfe" sanity filter as everything else,
// since a two-word query like "Gene Wolfe" can still occasionally surface
// something irrelevant.
async function fetchYouTubeSearch(source) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error(`[skip] ${source.name}: YOUTUBE_API_KEY not set — see README for setup`);
    return [];
  }
  try {
    const publishedAfter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      part: 'snippet',
      q: source.query,
      type: 'video',
      order: 'date',
      maxResults: '25',
      publishedAfter,
      key: apiKey
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, {
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    return (data.items || [])
      .filter(item => item.id?.videoId)
      .map(item => {
        const s = item.snippet || {};
        const title = s.title || 'Untitled';
        const desc = s.description || '';
        return {
          id: makeId(source.name, `https://www.youtube.com/watch?v=${item.id.videoId}`),
          title,
          source: s.channelTitle || 'YouTube',
          type: 'video',
          series: guessSeries(`${title} ${desc}`, source.series),
          date: (s.publishedAt || new Date().toISOString()).slice(0, 10),
          url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
          desc: desc.slice(0, 220),
          tags: guessTags(`${title} ${desc}`),
          thumbnail: s.thumbnails?.high?.url || s.thumbnails?.medium?.url || s.thumbnails?.default?.url || null
        };
      })
      .filter(item => `${item.title} ${item.desc}`.toLowerCase().includes('wolfe'));
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------
// URTH MAILING LIST (Pipermail)
// ---------------------------------------------------------------------
// Pipermail's monthly archive has a predictable, unchanged-in-decades HTML
// structure: a thread-index page listing every message as <A HREF="NNNN.html">
// with the subject as link text. Replies repeat the same subject, so we
// dedupe by subject to get one entry per thread.
//
// This list appears to have gone quiet or infrequent at some point (I
// couldn't confirm activity past ~2020-2021 while researching this), so
// rather than assume the current calendar month has an archive page —
// it often won't — this first reads the archive's own root index to find
// whichever month was actually most recently archived, then fetches that.
//
// Caveat: the thread-index page doesn't expose per-message timestamps, so
// dates are approximated to "today" (the day this script ran) rather than
// the actual post date.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const PIPERMAIL_BASE = 'http://lists.urth.net/pipermail/urth-urth.net/';

async function findLatestPipermailMonth() {
  const res = await fetch(PIPERMAIL_BASE, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading archive index`);
  const html = await res.text();
  const matches = [...html.matchAll(/href="(\d{4})-([A-Za-z]+)\/?(?:thread\.html)?"/gi)];
  let latest = null;
  for (const [, yearStr, monthName] of matches) {
    const monthIdx = MONTHS.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
    if (monthIdx === -1) continue;
    const year = parseInt(yearStr, 10);
    if (!latest || year > latest.year || (year === latest.year && monthIdx > latest.monthIdx)) {
      latest = { year, monthIdx };
    }
  }
  if (!latest) throw new Error('could not find any archived month on the index page');
  return `${PIPERMAIL_BASE}${latest.year}-${MONTHS[latest.monthIdx]}/thread.html`;
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function fetchPipermail(source) {
  try {
    const indexUrl = await findLatestPipermailMonth();
    const res = await fetch(indexUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const matches = [...html.matchAll(/<A HREF="(\d+\.html)">([^<]+)<\/A>/gi)];
    const seen = new Set();
    const items = [];
    for (const [, href, rawSubject] of matches) {
      const subject = decodeHtmlEntities(rawSubject.trim()).replace(/^Re:\s*/i, '');
      if (!subject || seen.has(subject)) continue; // dedupe replies to the same thread
      seen.add(subject);
      const url = new URL(href, indexUrl).toString();
      items.push({
        id: makeId(source.name, url),
        title: subject,
        source: source.name,
        type: 'discussion',
        series: guessSeries(subject, source.series),
        date: new Date().toISOString().slice(0, 10), // approximate — see comment above
        url,
        desc: 'Thread on the Urth Mailing List (urth.net), an active Gene Wolfe discussion list running since the 1990s.',
        tags: guessTags(subject)
      });
    }
    // Two consecutive live runs showed exactly 1 item here — plausible if
    // the archived month genuinely only had one active thread, but also
    // exactly the signature a dedup bug would produce (many raw messages
    // collapsing to one subject incorrectly). Logging the raw pre-dedup
    // match count settles which one it actually is, the same diagnostic
    // approach that found the real Crossref bug rather than guessing.
    console.log(`[debug] ${source.name}: ${matches.length} raw thread-index links, ${items.length} unique after dedup`);
    return items.slice(0, 15); // most recently-listed threads for the month
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// Pulls a thumbnail out of a parsed RSS item: YouTube's <media:thumbnail>,
// or a podcast's per-episode or channel-level <itunes:image>.
function extractThumbnail(item, feed, source) {
  if (source.kind === 'youtube') {
    const mediaThumb = item.mediaGroup?.['media:thumbnail']?.[0]?.$?.url;
    if (mediaThumb) return mediaThumb;
  }
  if (item.itunes?.image) return item.itunes.image;
  if (feed.itunes?.image) return feed.itunes.image;
  return null;
}

async function fetchSource(source) {
  if (source.kind === 'pipermail') return fetchPipermail(source);
  if (source.kind === 'reddit-rss') return fetchRedditRss(source);
  if (source.kind === 'deviantart') return FAN_ART_ENABLED ? fetchDeviantArt(source) : [];
  if (source.kind === 'bluesky') return FAN_ART_ENABLED ? fetchBlueskyArt(source) : [];
  if (source.kind === 'crossref') return fetchCrossref(source);
  if (source.kind === 'patreon') return fetchPatreon(source);
  if (source.kind === 'youtube-search') return fetchYouTubeSearch(source);

  const feedUrl = source.kind === 'youtube' ? youtubeFeedUrl(source.channelId) : source.url;
  try {
    const feed = await parser.parseURL(feedUrl);
    return feed.items
      // Some sources are general-interest, not Wolfe-dedicated — same
      // situation Crossref was in with "gene" matching unrelated genetics
      // papers. requireKeyword filters a source's *own* items down to the
      // ones actually relevant, the same fix, applied generically instead
      // of writing a one-off for each noisy source. Optional — sources
      // without it (the dedicated ones) are unaffected.
      .filter(item => !source.requireKeyword ||
        `${item.title || ''} ${item.contentSnippet || ''}`.toLowerCase().includes(source.requireKeyword.toLowerCase()))
      .slice(0, 8)
      .map(item => ({
        id: makeId(source.name, item.link),
        title: item.title || 'Untitled',
        source: source.name,
        type: source.type,
        series: guessSeries(`${item.title} ${item.contentSnippet || ''}`, source.series),
        date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
        url: item.link,
        desc: (item.contentSnippet || '').slice(0, 220),
        tags: guessTags(`${item.title || ''} ${item.contentSnippet || ''}`),
        thumbnail: extractThumbnail(item, feed, source)
      }));
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// Wraps any fetchSource call with timing, logged regardless of whether the
// source succeeds or [skip]s. Two runs in a row took far longer overall
// (15+ minutes) than the configured per-request timeouts should allow
// (worst case should be under 2 minutes: the last staggered Reddit request
// at ~75s, everything else well under that, all running in parallel) — so
// something is taking much longer than its timeout suggests. Rather than
// guess a third time, this makes the next run's log show exactly which
// source(s) are the actual bottleneck.
async function timedFetch(source) {
  const start = Date.now();
  const result = await fetchSource(source);
  console.log(`[timing] ${source.name}: ${((Date.now() - start) / 1000).toFixed(1)}s (${result.length} item${result.length===1?'':'s'})`);
  return result;
}

async function main() {
  const results = await Promise.all(SOURCES.map(timedFetch));
  let allItems = results.flat().sort((a, b) => b.date.localeCompare(a.date));

  // Global dedup by URL, across all sources — needed now that the YouTube
  // search source (see fetchYouTubeSearch) can surface the exact same
  // video a named channel's RSS already pulled in independently. Each
  // source generates its own `id` via makeId(source.name, url), so the
  // same video from two different sources would otherwise get two
  // different ids and show up as two separate cards. Keeps whichever
  // copy was seen first — sources earlier in SOURCES win, which in
  // practice means a named channel's own listing is preferred over the
  // same video showing up via search.
  const seenUrls = new Set();
  const beforeDedup = allItems.length;
  allItems = allItems.filter(item => {
    if (!item.url || seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });
  if (beforeDedup !== allItems.length) {
    console.log(`[dedup] Removed ${beforeDedup - allItems.length} duplicate(s) seen across multiple sources`);
  }

  // generatedAt records when the fetcher last actually ran — distinct from
  // any item's own date. A source can go quiet (no new posts) while the
  // pipeline itself is still healthy; generatedAt is what index.html uses
  // to show "Updated Xh ago" and to tell that apart from a broken Action.
  const output = { generatedAt: new Date().toISOString(), items: allItems };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote ${allItems.length} items to data.json`);
}

// Explicit exit rather than letting the process wind down naturally: a
// live run's own [timing] logs showed every source finishing within ~61s,
// yet the step took ~5 minutes — a gap of dead time after the real work
// was done, most likely a dangling keep-alive connection somewhere (rss-
// parser or fetch) keeping Node's event loop alive. Forcing exit(0) here
// avoids waiting that out. main().then()/.catch() also gives failures a
// proper non-zero exit code, which bare `main();` never did.
main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
