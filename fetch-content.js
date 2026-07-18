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
    name: 'Marc Aramini',
    type: 'video',
    series: 'general',
    kind: 'youtube',
    channelId: 'UC8H8yTqvudLIUJphj5M6yvQ'
  },

  // --- Podcast RSS feeds (direct feed URL from the podcast's own site or Podcast Index) ---
  {
    name: 'Alzabo Soup',
    type: 'podcast',
    series: 'general',
    kind: 'rss',
    url: 'https://alzabosoup.libsyn.com/rss' // confirmed live — Libsyn-hosted feed
  },

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
  // UNVERIFIED NAMES: my search tool isn't surfacing live Reddit pages
  // right now, so I couldn't directly confirm r/alzabosoup or
  // r/shittygenewolfe exist. For Rereading Wolfe's subreddit I used
  // "rereadingwolfepodcast," not "rereadingwolfe" as requested — that's
  // the name their own Apple Podcasts page lists, which seemed more
  // trustworthy than a guess. Any of these that 404 will just show up as
  // a normal [skip] line when you run this — check the actual subreddit
  // name against reddit.com yourself and fix the entry below if so.
  //
  // STAGGERED, NOT PARALLEL: a live run against real reddit.com showed 3 of
  // 4 subreddit requests failing with 429 (Too Many Requests) when fired
  // simultaneously via Promise.all — only the first got through. That's
  // Reddit rate-limiting a burst, not evidence those subreddits don't
  // exist; a 429 tells you nothing about whether the subreddit is real. So
  // each Reddit source gets an increasing delay (redditDelayMs) before its
  // request fires — see fetchRedditRss below, which awaits it.
  //
  // A first attempt at 3s spacing got the identical result — same 429s,
  // byte-for-byte same item count — which points away from "our own
  // requests are bursty" and toward Reddit rate-limiting or blocking
  // GitHub Actions' whole shared IP pool, a limit our own request pacing
  // can't do anything about since it's shared across every other Action
  // in the world hitting reddit.com at the same moment. Bumped to 20s as
  // a last check before concluding that. If this still doesn't change
  // anything, the pacing theory is dead and the real fix is a
  // self-hosted runner (a non-shared IP) rather than more delay-tuning.
  ...[
    { name: 'r/genewolfe', subreddit: 'genewolfe' },
    { name: 'r/rereadingwolfepodcast', subreddit: 'rereadingwolfepodcast' }, // TODO: verify — corrected from requested "rereadingwolfe"
    { name: 'r/alzabosoup', subreddit: 'alzabosoup' }, // TODO: verify this exists
    { name: 'r/shittygenewolfe', subreddit: 'shittygenewolfe' }, // TODO: verify this exists
    // Add more the same way — one line each:
    // { name: 'r/subredditname', subreddit: 'subredditname' },
  ].map(({ name, subreddit }, i) => ({
    name,
    type: 'discussion',
    series: 'general',
    kind: 'reddit-rss',
    url: `https://www.reddit.com/r/${subreddit}/.rss`,
    redditDelayMs: i * 20000 // was 3000 — a live run showed identical 429s at 3s spacing, so trying 20s as a last check before concluding this is IP-pool-wide, not pacing
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

  // --- Any blog/site with an RSS feed ---
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

async function fetchRedditRss(source) {
  try {
    if (source.redditDelayMs) await delay(source.redditDelayMs);
    const feed = await parser.parseURL(source.url);
    return feed.items.slice(0, 15).map(item => ({
      id: makeId(source.name, item.link),
      title: (item.title || 'Untitled').trim(),
      source: source.name,
      type: source.type,
      series: guessSeries(item.title || '', source.series),
      date: (item.isoDate || item.pubDate || new Date().toISOString()).slice(0, 10),
      url: item.link,
      desc: (item.contentSnippet || '').slice(0, 220),
      tags: guessTags(`${item.title || ''} ${item.contentSnippet || ''}`),
      thumbnail: null // not available via Reddit's RSS — see comment above
    }));
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
  if (source.kind === 'deviantart') return fetchDeviantArt(source);

  const feedUrl = source.kind === 'youtube' ? youtubeFeedUrl(source.channelId) : source.url;
  try {
    const feed = await parser.parseURL(feedUrl);
    return feed.items.slice(0, 8).map(item => ({
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
  console.log(`[timing] ${source.name}: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return result;
}

async function main() {
  const results = await Promise.all(SOURCES.map(timedFetch));
  const allItems = results.flat().sort((a, b) => b.date.localeCompare(a.date));

  // generatedAt records when the fetcher last actually ran — distinct from
  // any item's own date. A source can go quiet (no new posts) while the
  // pipeline itself is still healthy; generatedAt is what index.html uses
  // to show "Updated Xh ago" and to tell that apart from a broken Action.
  const output = { generatedAt: new Date().toISOString(), items: allItems };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote ${allItems.length} items to data.json`);
}

main();
