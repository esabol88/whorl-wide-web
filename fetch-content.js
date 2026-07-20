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

// Fan art detection: re-enabled. Originally turned off because the
// detection heuristic (Reddit: "does this post have an embedded image,"
// Bluesky: same) can't tell real fan art apart from memes, screenshots, or
// reaction images — r/shittygenewolfe made this especially bad, since it's
// a joke/meme subreddit by name and every image post there was getting
// reclassified as "fan art" with nothing to stop it. That subreddit has
// since been removed from SOURCES entirely (separate decision, on direct
// feedback that it wasn't adding value generally) — the two subreddits
// still tracked (r/genewolfe, r/rereadingwolfepodcast) are a general
// discussion sub and a podcast companion sub, not a meme sub, so the
// specific thing that made this noisy is gone. Worth trying again under
// meaningfully different conditions, not just flipping the same switch
// back blind. Bluesky is still blocked from GitHub Actions regardless
// (see fetchBlueskyArt), so this mostly just re-enables Reddit's
// detection in practice. DeviantArt (real image + artist attribution + a
// real content rating, not a blunt "has an image" guess) was never the
// problem and is also still blocked separately either way.
const FAN_ART_ENABLED = true;

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
    url: 'https://alzabosoup.libsyn.com/rss', // confirmed live — Libsyn-hosted feed
    // Direct report: episode links were routing to a book-category
    // "playlist" page on their site instead of the specific episode. See
    // resolveItemUrl above fetchSource's generic RSS handler for the
    // reasoning — tries <guid> first if it looks like a real URL, an
    // unverified but reasoned attempt at a fix.
    preferGuidUrl: true
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
  // signature as DeviantArt and Bluesky — a third platform pointing at the
  // same root cause, GitHub Actions' shared IP pool being blocked outright
  // rather than anything fixable from this file. Later confirmed to be a
  // platform-wide Substack block, not specific to this blog — see the
  // comment above the "Six more added" block further down, where four
  // more independent Substack sources failed identically in the same run.
  // Left in rather than removed, same reasoning as DeviantArt/Bluesky:
  // could plausibly work from a different environment even though it
  // doesn't work here.
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

  // Six more added from a research pass specifically on Substack/Medium
  // Wolfe writing — scoped to people shown to have written about Wolfe
  // more than once, or flagged as likely to keep doing so, rather than
  // adding every one-off essay found (many are one Wolfe piece inside an
  // otherwise-unrelated newsletter — those went to the Reference Shelf
  // instead, see index.html, not here as ongoing feeds).
  //
  // CONFIRMED: Substack as a whole platform blocks GitHub Actions' IP
  // range, not just one blog. Wolf (radicaledward) was already known
  // blocked; a live run then showed all four *other* Substack sources
  // below (Don Beck, Floyd Holland, Lincoln Michel, Andy Lee) failing
  // with the identical instant 403 in the same run — five separate
  // Substack blogs, same platform, same failure, same signature as
  // DeviantArt and Bluesky. Left in anyway, same reasoning as those two:
  // could plausibly work from a different environment even though it
  // doesn't work here. Medium and WordPress are NOT affected by this —
  // Mannish Boy (Medium) and Dave Hook (WordPress) below both reach their
  // servers fine, they just haven't had recent Wolfe-tagged posts.
  {
    name: 'Mannish Boy',
    type: 'article',
    series: 'new',
    kind: 'rss',
    url: 'https://medium.com/feed/@mannishboywrites',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Don Beck', // CONFIRMED BLOCKED — Substack, see comment block above
    type: 'article',
    series: 'general',
    kind: 'rss',
    url: 'https://donbeck1.substack.com/feed',
    requireKeyword: 'wolfe'
  },
  // Proof-of-concept for routing around the Substack block via Google
  // Alerts — see fetchGoogleAlerts above for the full explanation. Kept
  // as a separate source entry alongside the direct (blocked) one above
  // rather than replacing it outright, so the direct source keeps
  // recording a real skip line if the block is ever lifted, instead of
  // silently disappearing from the log.
  {
    name: 'Don Beck (via Google Alerts)',
    type: 'article',
    series: 'general',
    kind: 'google-alerts',
    url: 'https://www.google.com/alerts/feeds/15672596926670156383/13794794078402339525'
  },
  // Same route-around, extended to the other four confirmed-blocked
  // Substack sources — see fetchGoogleAlerts and the comment above Don
  // Beck's entry for the full explanation. Each kept alongside its direct
  // (blocked) source rather than replacing it, same reasoning: the direct
  // one keeps recording a real skip line if the block is ever lifted.
  {
    name: 'Floyd Holland (via Google Alerts)',
    type: 'article',
    series: 'general',
    kind: 'google-alerts',
    url: 'https://www.google.com/alerts/feeds/15672596926670156383/17407109298692797003'
  },
  {
    name: 'Lincoln Michel (via Google Alerts)',
    type: 'article',
    series: 'general',
    kind: 'google-alerts',
    url: 'https://www.google.com/alerts/feeds/15672596926670156383/9768491324716782172'
  },
  {
    name: 'Andy Lee (via Google Alerts)',
    type: 'article',
    series: 'general',
    kind: 'google-alerts',
    url: 'https://www.google.com/alerts/feeds/15672596926670156383/12132993125103068978'
  },
  {
    name: 'Wolf (radicaledward, via Google Alerts)',
    type: 'article',
    series: 'new',
    kind: 'google-alerts',
    url: 'https://www.google.com/alerts/feeds/15672596926670156383/16046406100643461909'
  },
  {
    name: 'Floyd Holland', // CONFIRMED BLOCKED — Substack, see comment block above
    type: 'article',
    series: 'general',
    kind: 'rss',
    url: 'https://floydholland.substack.com/feed',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Lincoln Michel', // CONFIRMED BLOCKED — Substack, see comment block above
    type: 'article',
    series: 'general',
    kind: 'rss',
    url: 'https://countercraft.substack.com/feed',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Andy Lee', // CONFIRMED BLOCKED — Substack, see comment block above
    type: 'article',
    series: 'general',
    kind: 'rss',
    url: 'https://litandchess.substack.com/feed',
    requireKeyword: 'wolfe'
  },
  {
    name: 'Dave Hook',
    type: 'article',
    series: 'general',
    kind: 'rss',
    url: 'https://adeeplookbydavehook.wordpress.com/feed/',
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
// CONFIRMED LIVE, and fixed based on real evidence rather than left as a
// guess: a first version of this function (just an <img> search) missed
// images on posts that clearly have one (title "Illustration: A Boy and
// his Dog," genuine original art) — the raw content snippet cut off right
// at "<span><a href=", strongly suggesting Reddit's RSS links to the
// image via a plain <a href="..."> anchor for these posts, not an <img>
// tag at all. Now checks both: the original <img> pattern first, then
// falls back to an <a href="..."> whose URL is an image file or a known
// Reddit/imgur image host — catching the link-only case the old version
// completely missed.
function extractRedditThumbnail(html) {
  const content = html || '';
  const imgMatch = content.match(/<img[^>]+src="([^"]+)"/i);
  if (imgMatch) return imgMatch[1].replace(/&amp;/g, '&');
  const linkMatch = content.match(/<a href="(https:\/\/(?:i\.redd\.it|i\.imgur\.com|preview\.redd\.it|external-preview\.redd\.it)\/[^"]+|[^"]+\.(?:jpg|jpeg|png|gif|webp))"/i);
  return linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : null;
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

// "Has an embedded image" alone was the whole problem before — it can't
// tell real fan art apart from a meme, a screenshot, or someone's photo
// of a red-looking sunset captioned "New Sun vibes." Requiring the
// title/text to actually say something art-related fixes this directly:
// real fan art posts overwhelmingly say so ("[OC] Severian portrait,"
// "my art of...", "posted on DeviantArt") in a way a meme or an unrelated
// photo essentially never does. Word-boundary matched so short entries
// like "art" or "oc" don't false-positive inside unrelated words (won't
// match inside "Arthur" or "chocolate"). Not foolproof — a real art post
// with a caption-free title could still be missed — but a missed real
// post is a much smaller problem than a feed full of memes, the same
// trade made for Crossref's "must say wolfe" filter.
const ART_SIGNAL_RE = /\b(art|artwork|fanart|fan art|drawing|draw|redraw|painting|paint|sketch|illustration|doodle|portrait|lineart|line art|commission|oc|deviantart|artstation|pixiv|tumblr|instagram)\b/i;

async function fetchRedditRss(source) {
  try {
    if (source.redditDelayMs) await delay(source.redditDelayMs);
    const feed = await parser.parseURL(source.url);
    // Scans a wider pool (20) than it ultimately keeps (6) — a real
    // report of specific art posts not showing up traced back to this:
    // they simply weren't among the top 6 most-upvoted posts of the
    // month, so they were never even looked at, regardless of the
    // content filter. Same shape of fix as Crossref's wide-candidate-
    // pool-then-filter approach. The final cap stays 6 for the original
    // reason (keeping one niche subreddit's whole month of posts from
    // outnumbering every other source in the feed by sheer volume) — only
    // the scanning window widened, not the output volume.
    const items = feed.items.slice(0, 20).map(item => {
      const title = (item.title || 'Untitled').trim();
      const snippet = item.contentSnippet || '';
      const thumbnail = extractRedditThumbnail(item.content);
      const hasImage = !!thumbnail;
      const signalMatch = ART_SIGNAL_RE.test(`${title} ${snippet}`);
      const isArt = FAN_ART_ENABLED && hasImage && signalMatch;
      // Direct reports of art posts miscategorized as Discussion turned
      // out to mostly have a strong keyword match already ("cover art
      // by...", "Illustration: ...") — meaning the previous version of
      // this diagnostic had a real blind spot: it only logged posts that
      // *already* had a detected image, so a post failing at the image-
      // detection step (extractRedditThumbnail finding no <img> tag —
      // plausible for gallery posts or externally-hosted images, e.g. a
      // post crediting an artist on Bluesky rather than hosting the image
      // on Reddit itself) would never show up in the log at all, keyword
      // match or not. Now logs both directions: the original "has an
      // image" case, and this new "keyword matched but no image found"
      // case — the latter includes a raw content snippet so the actual
      // HTML Reddit's RSS sent is visible, instead of guessing why
      // extraction failed.
      if (hasImage) {
        const cats = (item.categories || []).join(',') || 'none';
        console.log(`[debug] ${source.name}: "${title.slice(0,60)}" image=yes (${thumbnail.slice(0,80)}) signal=${signalMatch} categories=[${cats}]`);
      } else if (signalMatch) {
        console.log(`[debug] ${source.name}: "${title.slice(0,60)}" image=NO signal=yes — raw content: ${(item.content || '').slice(0,600)}`);
      }
      const author = isArt ? extractRedditAuthor(item) : null;
      return {
        id: makeId(source.name, item.link),
        title,
        source: source.name,
        type: isArt ? 'fanart' : source.type,
        series: guessSeries(title, source.series),
        date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
        url: item.link,
        desc: snippet.slice(0, 220),
        tags: guessTags(`${title} ${snippet}`),
        thumbnail,
        ...(isArt ? {
          artist: author ? `u/${author} (Reddit)` : 'Unknown artist (via Reddit)',
          artistUrl: author ? `https://www.reddit.com/user/${author}` : null,
          postUrl: item.link,
          nsfw: redditTitleNsfw(title)
        } : {})
      };
    });
    // A plain slice(0,6) here would just reproduce the original top-6-by-
    // votes result and defeat the point of scanning 20 — an art post
    // found further down the list needs to actually displace something
    // to matter. Art matches get priority for the 6 final slots;
    // remaining slots backfill with top-ranked regular posts. Order
    // within this array doesn't affect what the reader sees either way —
    // everything gets re-sorted by date once merged with every other
    // source in main() — only which items get kept here matters.
    const artItems = items.filter(i => i.type === 'fanart');
    const nonArtItems = items.filter(i => i.type !== 'fanart');
    return [...artItems, ...nonArtItems].slice(0, 6);
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
// GOOGLE ALERTS (routes around Substack's confirmed IP block)
// ---------------------------------------------------------------------
// Every Substack source in this file is blocked outright — GitHub
// Actions' IP range, confirmed across five separate blogs (see comments
// near Wolf/radicaledward and the "Six more added" block above). This
// sidesteps the block entirely rather than trying to defeat it: instead
// of fetching Substack directly, it consumes a Google Alerts RSS feed —
// a search alert (e.g. "Gene Wolfe" site:donbeck1.substack.com) that
// *Google's own crawler* keeps fresh, delivered as RSS. We're making a
// request to google.com, not substack.com, so the Substack-specific
// block shouldn't apply at all.
//
// Two known quirks specific to this feed format, handled defensively
// since a live preview wasn't possible to confirm against (Google's
// robots.txt blocks even read-only tooling from fetching an alerts feed
// directly, a courtesy convention our own fetch() call doesn't follow —
// so this is informed by how Google Alerts feeds are generally
// structured, not confirmed against this specific one):
//   1. Google often wraps the result link in a redirect
//      ("google.com/url?q=REAL_URL&..."), which would otherwise send a
//      reader to an intermediate Google page instead of the actual post.
//      Unwrapped below by pulling the real URL out of the `q` parameter.
//   2. Google Alerts bolds matching search terms directly in the title
//      using literal <b> tags, which would otherwise leak as visible
//      "<b>Gene</b> <b>Wolfe</b>" markup in the card — stripped below.
// NOT VERIFIED LIVE for either of these — needs a real run to confirm.
async function fetchGoogleAlerts(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 10).map(item => {
      const title = stripHtmlTags(item.title || 'Untitled');
      const snippet = stripHtmlTags(item.contentSnippet || item.content || '');
      let url = item.link || '';
      const redirectMatch = url.match(/[?&]q=([^&]+)/);
      if (redirectMatch) url = decodeURIComponent(redirectMatch[1]);
      return {
        id: makeId(source.name, url),
        title,
        source: source.name,
        type: 'article',
        series: guessSeries(`${title} ${snippet}`, source.series),
        date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
        url,
        desc: snippet.slice(0, 220),
        tags: guessTags(`${title} ${snippet}`)
      };
    }).filter(item => item.url);
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

// Pipermail's monthly thread-index page lists subjects and authors, but
// not dates — the reason fetchPipermail used to just stamp every item
// with today's date as an approximation. A direct report showed how bad
// that approximation actually was in practice: a post from June 4th
// showing as "JUL 18," six weeks off, not a rounding error.
//
// First attempt at fetching each message's own page for its real date
// used a regex assuming "Day Mon DD HH:MM:SS YYYY" wrapped in <I> tags —
// still not showing real dates on a live run, so that guess was wrong.
// Found actual evidence this time instead of guessing again: an archived
// message page turned up in search with the literal text "Roy C. Lackey
// rclackey at stic.net Tue Dec 23 13:45:24 PST 2008" — confirming the
// real format has a timezone abbreviation (PST) sitting BETWEEN the time
// and the year, which the old regex had no room for at all. Fixed the
// pattern to account for it, and loosened the <I>-tag requirement too
// (still unconfirmed whether that's the actual wrapper) by searching the
// whole page for this fairly distinctive date shape rather than requiring
// specific surrounding markup — safe to do since Mailman's own rendered
// date uses "Tue Dec 23 13:45:24 PST 2008" (no comma, TZ abbreviation),
// clearly different from a quoted reply's "Date:" header further down the
// page, which uses RFC 2822's comma-and-numeric-offset format instead
// ("Fri, 18 Jul 2014 17:09:38 -0700") — so this shouldn't accidentally
// latch onto a quoted date buried in someone's reply text.
//
// STILL NOT FULLY VERIFIED LIVE — evidence came from search-engine text
// extraction, not the raw HTML itself, so the exact tag structure remains
// unconfirmed. Fails safe either way: falls back to today's date exactly
// like before if nothing matches, same as the first attempt.
async function fetchMessageDate(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/\b([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+[A-Z]{2,5}\s+\d{4})\b/);
    if (!match) return null;
    const parsed = new Date(match[1]);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  } catch {
    return null;
  }
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
        date: new Date().toISOString().slice(0, 10), // placeholder — replaced below if the real date resolves
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
    const kept = items.slice(0, 15); // most recently-listed threads for the month
    // Fetch each kept item's own page in parallel for its real date —
    // only the ones actually being kept, not the full pre-slice set, to
    // avoid wasting requests on items that get discarded anyway.
    let resolvedCount = 0;
    await Promise.all(kept.map(async item => {
      const realDate = await fetchMessageDate(item.url);
      if (realDate) { item.date = realDate; resolvedCount++; }
    }));
    console.log(`[debug] ${source.name}: resolved real dates for ${resolvedCount}/${kept.length} items`);
    return kept;
  } catch (err) {
    console.error(`[skip] ${source.name}: ${err.message}`);
    return [];
  }
}

// Most RSS feeds' <link> is a genuine per-item permalink, but some podcast
// hosts populate it with a category/show-level URL instead of the
// specific episode's own page. Confirmed for Alzabo Soup by direct report:
// their <link> was routing to a book-specific category archive
// (alzabosoup.com/categories/the-book-of-the-short-sun/ — a real page on
// their site) instead of the actual episode, described as "goes to the
// playlist, not straight to the episode." For sources with
// preferGuidUrl set, this tries the item's own <guid> first, since GUIDs
// are more often true permalinks even when <link> isn't — but only if
// it's actually a well-formed URL, since some feeds use an opaque
// non-URL string as their guid instead. Falls back to <link> either way
// if guid isn't usable.
//
// NOT VERIFIED LIVE — couldn't inspect Alzabo Soup's raw RSS XML directly
// to confirm what's actually in their <guid> (fetch tools returned it as
// binary, and the domain isn't reachable from the sandbox this was built
// in either). A reasoned attempt from circumstantial evidence, not a
// confirmed fix — check the next real run's Alzabo Soup links by hand.
function resolveItemUrl(item, source) {
  if (source.preferGuidUrl && item.guid && /^https?:\/\//i.test(item.guid)) {
    return item.guid;
  }
  return item.link;
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
  if (source.kind === 'google-alerts') return fetchGoogleAlerts(source);

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
      .map(item => {
        const url = resolveItemUrl(item, source);
        return {
          id: makeId(source.name, url),
          title: item.title || 'Untitled',
          source: source.name,
          type: source.type,
          series: guessSeries(`${item.title} ${item.contentSnippet || ''}`, source.series),
          date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
          url,
          desc: (item.contentSnippet || '').slice(0, 220),
          tags: guessTags(`${item.title || ''} ${item.contentSnippet || ''}`),
          thumbnail: extractThumbnail(item, feed, source)
        };
      });
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

// Known pieces no automated source can discover on its own — either
// predating any feed/alert that could have caught them, or behind the
// confirmed Substack block regardless. Originally added to the Reference
// Shelf, moved here on request: these are dated articles, not durable
// reference material, so they belong in the feed as real cards — sortable
// by date, filterable by type/series/tag — not a separate static list.
// Unlike data.json, which gets fully regenerated every run, this array
// lives in the source code, so these persist permanently without needing
// rediscovery. Two dates below are approximate — flagged individually —
// where the original research only gave a month, not an exact day.
const MANUAL_ITEMS = [
  {
    id: 'manual-donbeck-nextread',
    title: 'Your Next Read: The Book of the New Sun',
    source: 'Don Beck',
    type: 'article',
    series: 'new',
    date: '2025-05-23',
    url: 'https://donbeck1.substack.com/p/your-next-read-the-book-of-the-new',
    desc: "An enthusiastic, accessible first-reader case for New Sun being genuinely life-changing, without pretending it'll suit everyone.",
    tags: guessTags('Your Next Read: The Book of the New Sun')
  },
  {
    // Date approximate — original research described this as a
    // craft-oriented follow-up to the piece above, no exact date given.
    id: 'manual-donbeck-structure',
    title: 'Structure of the New Sun',
    source: 'Don Beck',
    type: 'article',
    series: 'new',
    date: '2025-06-01',
    url: 'https://donbeck1.substack.com/p/structure-of-the-new-sun',
    desc: "A craft-oriented follow-up on Wolfe's unconventional placement of rising action, climax, and structural turns.",
    tags: guessTags('Structure of the New Sun')
  },
  {
    // Date approximate — original research only gave "January 2025," no
    // specific day.
    id: 'manual-floydholland-prose',
    title: 'The Enchanting Prose of Gene Wolfe',
    source: 'Floyd Holland',
    type: 'article',
    series: 'general',
    date: '2025-01-15',
    url: 'https://floydholland.substack.com/p/the-enchanting-prose-of-gene-wolfe',
    desc: 'A close prose analysis using The Fifth Head of Cerberus — sentence density, parenthetical complication, memory, and perspective.',
    tags: guessTags('The Enchanting Prose of Gene Wolfe Fifth Head of Cerberus')
  },
  {
    id: 'manual-lincolnmichel-whyread',
    title: 'Why You Should Read Gene Wolfe (and Where to Start)',
    source: 'Lincoln Michel',
    type: 'article',
    series: 'general',
    date: '2026-01-08',
    url: 'https://countercraft.substack.com/p/why-you-should-read-gene-wolfe-and',
    desc: 'Probably the best recent general introduction — Peace for literary readers, Fifth Head for established SF readers, plus the short fiction.',
    tags: guessTags('Why You Should Read Gene Wolfe Peace Fifth Head of Cerberus')
  },
  {
    id: 'manual-andylee-peace',
    title: "Gene Wolfe's Peace",
    source: 'Andy Lee',
    type: 'article',
    series: 'general',
    date: '2026-07-12',
    url: 'https://litandchess.substack.com/p/gene-wolfes-peace',
    desc: "A literary treatment of narrative voice, concealed violence, and memory — and Peace's relationship to Poe, Nabokov, and postmodern fiction.",
    tags: guessTags("Gene Wolfe's Peace")
  },
  {
    // This is a representative entry point into a many-post ongoing (now
    // paused) chapter-by-chapter project, not a single dated essay like
    // everything else in this list — the date is a rough approximation,
    // not tied to a specific confirmed publish date the way the other
    // entries are.
    id: 'manual-radicaledward-newsun',
    title: 'The Book of the New Sun (chapter-by-chapter read)',
    source: 'Wolf (radicaledward)',
    type: 'article',
    series: 'new',
    date: '2025-02-01',
    url: 'https://radicaledward.substack.com/p/the-book-of-the-new-sun',
    desc: 'A slow, chapter-by-chapter literary read — voice, structure, and imagery — getting well into The Claw of the Conciliator before going on hiatus. Start here for the whole archive.',
    tags: guessTags('The Book of the New Sun chapter by chapter Severian')
  },
  {
    // No `thumbnail` field, deliberately — a verified, stable, hotlink-
    // safe image URL for this specific piece wasn't findable through
    // available tools (auction houses, Pinterest, and gallery sites don't
    // expose that kind of URL to search, and there's no live browser
    // access here to grab one directly from Goodreads). Rather than guess
    // a plausible-looking image URL and risk it breaking on the live
    // site, this falls back to the palette icon tile — the same fallback
    // every fan art card already uses before a real thumbnail loads, now
    // deliberately relied on here instead of treated as a rare edge case.
    id: 'manual-donmaitz-newsun',
    title: 'The Book of the New Sun — original US cover paintings',
    source: 'Don Maitz',
    type: 'fanart',
    series: 'new',
    date: '1980-05-01',
    url: 'https://en.wikipedia.org/wiki/The_Shadow_of_the_Torturer',
    desc: "The original American cover paintings for all four New Sun volumes — the foundational visual interpretation of Severian, still in print on many editions decades later.",
    tags: guessTags('Book of the New Sun cover art Severian'),
    artist: 'Don Maitz',
    artistUrl: 'https://www.paravia.com/DonMaitz/',
    postUrl: 'https://en.wikipedia.org/wiki/The_Shadow_of_the_Torturer',
    nsfw: false
  },
  {
    // Same situation as Maitz above — no verified image URL, deliberately
    // falls back to the palette icon.
    id: 'manual-brucepennington-newsun',
    title: 'The Book of the New Sun — original UK cover paintings',
    source: 'Bruce Pennington',
    type: 'fanart',
    series: 'new',
    date: '1980-06-01',
    url: 'https://www.brucepennington.co.uk/',
    desc: 'The original British cover paintings — immense, ancient landscapes and cosmic decay rather than character portraiture, a very different visual take from the American edition.',
    tags: guessTags('Book of the New Sun cover art landscape'),
    artist: 'Bruce Pennington',
    artistUrl: 'https://www.brucepennington.co.uk/',
    postUrl: 'https://www.brucepennington.co.uk/',
    nsfw: false
  },
  {
    id: 'manual-theringer-highart',
    title: 'Gene Wolfe Turned Science Fiction Into High Art',
    source: 'The Ringer',
    type: 'article',
    series: 'general',
    date: '2019-04-25',
    url: 'https://theringer.com/platform/amp/2019/4/25/18515675/gene-wolfe-science-fiction-author',
    desc: "A retrospective written the week Wolfe died in 2019, framing his life and work for readers who'd never heard the name — a good one to hand someone who's curious but hasn't started.",
    tags: guessTags('Gene Wolfe science fiction retrospective')
  },
  {
    id: 'manual-adamroberts-newsun',
    title: 'Gene Wolfe, "The Book of the New Sun" (1980-83)',
    source: 'Adam Roberts',
    type: 'article',
    series: 'new',
    date: '2023-07-03',
    url: 'https://medium.com/adams-notebook/gene-wolfe-the-book-of-the-new-sun-1980-83-ee4cc6d18410',
    desc: 'A substantial essay treating the tetralogy as perhaps the major fantasy sequence of its era — fantasy vs. science fiction, memory, structure, symbolism, the wider Solar Cycle.',
    tags: guessTags('Book of the New Sun fantasy science fiction')
  },
  {
    // Date approximate — original research gave "April 2015," no specific day.
    id: 'manual-bebergal-difficultgenius',
    title: "Sci-Fi's Difficult Genius",
    source: 'Peter Bebergal',
    type: 'article',
    series: 'general',
    date: '2015-04-15',
    url: 'https://www.newyorker.com/books/page-turner/sci-fis-difficult-genius',
    desc: "Still probably the most important mainstream profile — memory, unreliability, Catholicism, and Wolfe's own comments about his work and his wife Rosemary.",
    tags: guessTags('Gene Wolfe profile memory Catholicism')
  },
  // Eight more artists from the original research batch — same treatment
  // as Maitz/Pennington above: no `thumbnail` field, falls back to the
  // palette icon. All dates below are approximate/illustrative (staggered
  // across recent months) since none of these have a specific confirmed
  // publish date from the original research — flagged here rather than
  // presented as precise.
  {
    id: 'manual-alexanderpreuss-newsun',
    title: 'The Book of the New Sun — illustrations for Centipede Press',
    source: 'Alexander Preuss',
    type: 'fanart',
    series: 'new',
    date: '2025-03-01',
    url: 'https://www.artstation.com/artwork/a01qvz',
    desc: "Illustrating Wolfe's books for Centipede Press since 2006 — detailed, cinematic work unusually attentive to Wolfe's concealed science-fiction architecture.",
    tags: guessTags('Book of the New Sun illustration Centipede Press'),
    artist: 'Alexander Preuss',
    artistUrl: 'https://www.abalakin.de/',
    postUrl: 'https://www.artstation.com/artwork/a01qvz',
    nsfw: false
  },
  {
    // Nathan J. Anderson's own individual Reddit posts (as u/deimosremus)
    // already come through automatically via r/genewolfe — this entry is
    // his broader portfolio site specifically, a fuller "character bible"
    // overview rather than duplicating what the live feed already finds.
    id: 'manual-nathananderson-characterbible',
    title: 'The Book of the New Sun — character bible',
    source: 'Nathan J. Anderson (DeimosRemus)',
    type: 'fanart',
    series: 'new',
    date: '2025-04-01',
    url: 'https://www.nathanandersonart.com/newsun',
    desc: 'An extensive, ongoing character bible — Severian, the guild, weapons, creatures, costumes, architecture, and environments, useful for seeing how a described object might actually be constructed.',
    tags: guessTags('Book of the New Sun Severian character design'),
    artist: 'Nathan J. Anderson',
    artistUrl: 'https://www.nathanandersonart.com/newsun',
    postUrl: 'https://www.nathanandersonart.com/newsun',
    nsfw: false
  },
  {
    id: 'manual-ramonperales-fuligin',
    title: 'Book of Fuligin — illustrated anthology',
    source: 'Ramón Perales Cano (Ramonkey)',
    type: 'fanart',
    series: 'new',
    date: '2025-05-01',
    url: 'https://www.artstation.com/artwork/eJgg53',
    desc: 'Conceived, edited, and contributed to by Perales — a large illustrated anthology honoring Wolfe with nearly forty participating artists. Bold, graphic, comics-derived imagery. One page from the book; see his profile for more.',
    tags: guessTags('Book of Fuligin anthology comics'),
    artist: 'Ramón Perales Cano',
    artistUrl: 'https://ramonkeyperales.com/',
    postUrl: 'https://www.artstation.com/artwork/eJgg53',
    nsfw: false
  },
  {
    id: 'manual-erichewang-shadow',
    title: 'The Shadow of the Torturer — pen-and-ink series',
    source: 'Eric He',
    type: 'fanart',
    series: 'new',
    date: '2025-06-01',
    url: 'https://www.artstation.com/artwork/4d692',
    desc: 'Originally an Inktober project — stark blacks and medieval engraving quality, particularly compatible with a minimal, emblematic visual direction.',
    tags: guessTags('Shadow of the Torturer ink illustration'),
    artist: 'Eric He',
    artistUrl: 'https://eriche.artstation.com/',
    postUrl: 'https://www.artstation.com/artwork/4d692',
    nsfw: false
  },
  {
    id: 'manual-samweber-folio',
    title: 'The Claw of the Conciliator — Folio Society binding art',
    source: 'Sam Weber',
    type: 'fanart',
    series: 'new',
    date: '2018-01-01',
    url: 'https://sampaints.com/Book-of-The-New-Sun-Bindings-Claw',
    desc: "Weber spent almost a year illustrating the Folio Society's complete New Sun — literal textual investigation combined with surreal, art-historical symbolism. One binding of four; see his site for the full set.",
    tags: guessTags('Book of the New Sun Folio Society illustration Claw'),
    artist: 'Sam Weber',
    artistUrl: 'https://sampaints.com/',
    postUrl: 'https://sampaints.com/Book-of-The-New-Sun-Bindings-Claw',
    nsfw: false
  },
  {
    id: 'manual-vegadraws-gyoll',
    title: "Morwenna's Execution — process journal",
    source: 'Vega Draws',
    type: 'fanart',
    series: 'new',
    date: '2025-08-01',
    url: 'https://vegadraws.art/blog/morwenna-s-execution-art-process-journal',
    desc: 'Part of a self-described "slow, long-term project" to illustrate the Book of the New Sun — a detailed process journal developing the composition directly from the text.',
    tags: guessTags('Book of the New Sun Morwenna execution illustration'),
    artist: 'Vega Draws',
    artistUrl: 'https://vegadraws.art/',
    postUrl: 'https://vegadraws.art/blog/morwenna-s-execution-art-process-journal',
    nsfw: false
  },
  {
    id: 'manual-floatingdisc-lakeofbirds',
    title: 'Severian and Dorcas at the Lake of Birds',
    source: 'Floating Disc',
    type: 'fanart',
    series: 'new',
    date: '2025-09-01',
    url: 'https://floatingdisc.com/',
    desc: 'A currently active fan artist with a dedicated New Sun category and multiple pieces available as prints, not a single isolated illustration.',
    tags: guessTags('Severian Dorcas Lake of Birds'),
    artist: 'Floating Disc',
    artistUrl: 'https://floatingdisc.com/',
    postUrl: 'https://floatingdisc.com/',
    nsfw: false
  },
  {
    id: 'manual-andreakalfas-undine',
    title: 'Severian and the Undine',
    source: 'Andrea Kalfas',
    type: 'fanart',
    series: 'new',
    date: '2025-10-01',
    url: 'https://andreakalfas.tumblr.com/post/25648964563/severian-and-the-undine-a-scene-from-book-of-the',
    desc: 'Not a Wolfe-focused artist overall, but a memorable, decorative, medieval-modern illustration of Severian confronted by an undine — painted for a Paris gallery show, "The Book Show."',
    tags: guessTags('Severian undine illustration'),
    artist: 'Andrea Kalfas',
    artistUrl: 'https://www.andreakalfas.com/',
    postUrl: 'https://andreakalfas.tumblr.com/post/25648964563/severian-and-the-undine-a-scene-from-book-of-the',
    nsfw: false
  }
];

async function main() {
  const results = await Promise.all(SOURCES.map(timedFetch));
  let allItems = [...results.flat(), ...MANUAL_ITEMS].sort((a, b) => b.date.localeCompare(a.date));

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
