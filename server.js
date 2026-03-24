const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE_URL = "https://donghuaworld.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": BASE_URL,
  "Connection": "keep-alive"
};

// ─── Helper: Fetch HTML ────────────────────────────────────────────────────────
async function fetchPage(url) {
  try {
    const { data } = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000,
      maxRedirects: 5
    });
    return cheerio.load(data);
  } catch (err) {
    if (err.response) {
      throw new Error(`HTTP ${err.response.status}: Failed to fetch ${url}`);
    }
    throw new Error(`Network error: ${err.message}`);
  }
}

// ─── Helper: Extract image src (handles lazy-load) ────────────────────────────
function getImageSrc($el, $) {
  const img = $el.find('img').first();
  return (
    img.attr('src') ||
    img.attr('data-src') ||
    img.attr('data-lazy-src') ||
    img.attr('data-original') ||
    null
  );
}

// ─── Helper: Extract cards from listing pages ─────────────────────────────────
function extractCards($) {
  const results = [];
  const seen = new Set();

  // Try multiple selector patterns used by WordPress anime themes
  const selectors = [
    '.item',
    '.bs',
    'article.bs',
    '.animposx',
    '.bsx',
    '.excstyle',
    '.listupd .bs',
    'article',
    '.thumb'
  ];

  for (const sel of selectors) {
    $(sel).each((i, el) => {
      const $el = $(el);
      const $a = $el.find('a[href*="donghuaworld"]').first()
        || $el.find('a').first();

      const href = $a.attr('href') || '';
      const title =
        $el.find('.title, h2, h3, .tt').text().trim() ||
        $a.attr('title') ||
        $el.find('img').attr('alt') || '';

      if (!href || !title || seen.has(href)) return;
      seen.add(href);

      const slug = href.split('/').filter(Boolean).pop();
      const thumbnail = getImageSrc($el, $);
      const rating =
        $el.find('.numscore, .score, .rating, .imdb').text().trim() || null;
      const status =
        $el.find('.status, .stataus').text().trim() || null;
      const epBadge =
        $el.find('.epx, .epcur, .epnum').text().trim() || null;

      results.push({
        title: title.trim(),
        slug,
        url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
        thumbnail,
        rating: rating || null,
        status: status || null,
        latestEpisode: epBadge || null
      });
    });

    if (results.length > 0) break; // Stop at first working selector
  }

  return results;
}

// ─── GET /latest ──────────────────────────────────────────────────────────────
// Returns latest updated donghua. Supports ?page=N
app.get('/latest', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const url = page > 1
      ? `${BASE_URL}/anime/?order=update&page=${page}`
      : `${BASE_URL}/`;

    const $ = await fetchPage(url);
    const results = extractCards($);

    res.json({
      page,
      count: results.length,
      results
    });
  } catch (error) {
    console.error('[/latest]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /popular ─────────────────────────────────────────────────────────────
// Returns popular/trending donghua
app.get('/popular', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const $ = await fetchPage(`${BASE_URL}/anime/?order=popular&page=${page}`);
    const results = extractCards($);

    res.json({ page, count: results.length, results });
  } catch (error) {
    console.error('[/popular]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /search?q= ───────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: "Query param 'q' is required" });

    const $ = await fetchPage(`${BASE_URL}/?s=${encodeURIComponent(q)}&post_type=anime`);
    const results = extractCards($);

    // Fallback: try search result page selectors
    if (results.length === 0) {
      const fallback = [];
      $('.result-item, .search-item, .wp-post-image').each((i, el) => {
        const $el = $(el);
        const link = $el.find('a').first().attr('href') || $el.closest('a').attr('href');
        const title = $el.find('h2, h3, .title').text().trim() || '';
        if (link && title) {
          fallback.push({
            title,
            slug: link.split('/').filter(Boolean).pop(),
            url: link.startsWith('http') ? link : `${BASE_URL}${link}`,
            thumbnail: getImageSrc($el, $)
          });
        }
      });
      return res.json({ query: q, count: fallback.length, results: fallback });
    }

    res.json({ query: q, count: results.length, results });
  } catch (error) {
    console.error('[/search]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /series/:slug ────────────────────────────────────────────────────────
app.get('/series/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const $ = await fetchPage(`${BASE_URL}/anime/${slug}/`);

    // Title
    const title =
      $('h1.entry-title, h1.post-title, h1').first().text().trim() ||
      slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Synopsis
    const synopsis =
      $('[itemprop="description"], .entry-content, .synopsis, .desc, .summary__content')
        .first().text().trim()
        .replace(/\s+/g, ' ') || 'No synopsis available.';

    // Thumbnail
    const thumbnail =
      $('img.wp-post-image').attr('src') ||
      $('.poster img, .thumb img, .animpo img').first().attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      null;

    // Metadata
    const rating =
      $('[itemprop="ratingValue"], .score, .numscore').text().trim() || 'N/A';

    const genres = [];
    $('a[rel="tag"], .genres a, [itemprop="genre"]').each((i, el) => {
      const g = $(el).text().trim();
      if (g) genres.push(g);
    });

    const info = {};
    $('.infox .info, .spe span, .info-content span').each((i, el) => {
      const text = $(el).text();
      const [key, ...val] = text.split(':');
      if (key && val.length) info[key.trim()] = val.join(':').trim();
    });

    // Episodes
    const episodes = [];
    const epSelectors = [
      'a[href*="-episode-"]',
      '.ep-list a',
      '.episode-list a',
      '.episodelist a',
      '#episode_by_series a',
      '.eplister ul a',
      '.eplisterfull ul a'
    ];

    const epLinks = new Set();
    for (const sel of epSelectors) {
      $(sel).each((i, el) => {
        const epUrl = $(el).attr('href');
        if (epUrl && !epLinks.has(epUrl)) {
          epLinks.add(epUrl);
          const fullUrl = epUrl.startsWith('http') ? epUrl : `${BASE_URL}${epUrl}`;
          const epText = $(el).text().trim();
          const numMatch = epText.match(/\d+(\.\d+)?/);
          episodes.push({
            number: numMatch ? numMatch[0] : String(i + 1),
            title: epText || `Episode ${i + 1}`,
            url: fullUrl,
            slug: epUrl.split('/').filter(Boolean).pop()
          });
        }
      });
      if (episodes.length > 0) break;
    }

    // Sort episodes by number
    episodes.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));

    res.json({
      title,
      slug,
      url: `${BASE_URL}/anime/${slug}/`,
      synopsis,
      thumbnail,
      rating,
      genres,
      info,
      totalEpisodes: episodes.length,
      episodes: episodes.length > 0
        ? episodes
        : 'Episodes may require JavaScript rendering on the original site.'
    });
  } catch (error) {
    console.error('[/series]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /episode/:slug ───────────────────────────────────────────────────────
// Scrapes a single episode page and extracts video sources
app.get('/episode/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    // slug can be like "necromancer-episode-1" — we need its full URL
    // Try common URL patterns
    const candidateUrls = [
      `${BASE_URL}/${slug}/`,
      `${BASE_URL}/anime/${slug}/`,
    ];

    let $, finalUrl;
    for (const url of candidateUrls) {
      try {
        $ = await fetchPage(url);
        finalUrl = url;
        break;
      } catch { /* try next */ }
    }

    if (!$) {
      return res.status(404).json({ error: `Episode page not found for slug: ${slug}` });
    }

    const title = $('h1, .entry-title').first().text().trim() || slug;

    // Extract all iframes (video embeds)
    const servers = [];
    $('iframe[src], iframe[data-src]').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src && !src.includes('disqus') && !src.includes('facebook')) {
        servers.push({ server: `Server ${i + 1}`, embedUrl: src });
      }
    });

    // Extract from JS variables (common in anime sites)
    const html = $.html();
    const sourceMatches = html.matchAll(/["'](?:file|src|source)["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)/g);
    const directLinks = [];
    for (const match of sourceMatches) {
      directLinks.push(match[1]);
    }

    // Extract server selector buttons
    const serverList = [];
    $('.mirror option, .server option, .sources option, [data-video]').each((i, el) => {
      const $el = $(el);
      const label = $el.text().trim();
      const embedUrl = $el.attr('value') || $el.attr('data-video') || '';
      if (label && embedUrl) serverList.push({ label, embedUrl });
    });

    // Navigation
    const prevEp = $('a.prev, .nav-previous a, a[rel="prev"]').first().attr('href') || null;
    const nextEp = $('a.next, .nav-next a, a[rel="next"]').first().attr('href') || null;

    // Series link
    const seriesUrl =
      $('a[href*="/anime/"]:not([href*="episode"])').first().attr('href') || null;

    res.json({
      title,
      slug,
      url: finalUrl,
      seriesUrl: seriesUrl ? (seriesUrl.startsWith('http') ? seriesUrl : `${BASE_URL}${seriesUrl}`) : null,
      servers: servers.length ? servers : serverList,
      directVideoLinks: directLinks.length ? [...new Set(directLinks)] : [],
      navigation: {
        prev: prevEp ? (prevEp.startsWith('http') ? prevEp : `${BASE_URL}${prevEp}`) : null,
        next: nextEp ? (nextEp.startsWith('http') ? nextEp : `${BASE_URL}${nextEp}`) : null
      }
    });
  } catch (error) {
    console.error('[/episode]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /genre/:genre ────────────────────────────────────────────────────────
app.get('/genre/:genre', async (req, res) => {
  try {
    const { genre } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const $ = await fetchPage(`${BASE_URL}/genres/${genre}/page/${page}/`);
    const results = extractCards($);

    res.json({ genre, page, count: results.length, results });
  } catch (error) {
    console.error('[/genre]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET / (API docs) ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'DonghuaWorld Scraper API',
    version: '2.0.0',
    status: '✅ Running',
    endpoints: {
      'GET /latest': 'Latest updated donghua. ?page=N',
      'GET /popular': 'Popular donghua. ?page=N',
      'GET /search': 'Search. ?q=<title>',
      'GET /series/:slug': 'Series details + episode list',
      'GET /episode/:slug': 'Episode page + video server URLs',
      'GET /genre/:genre': 'Browse by genre. ?page=N'
    },
    examples: {
      latest: '/latest?page=1',
      popular: '/popular',
      search: '/search?q=Battle Through the Heavens',
      series: '/series/battle-through-the-heavens',
      episode: '/episode/battle-through-the-heavens-episode-1',
      genre: '/genre/action?page=1'
    }
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 DonghuaWorld API running → http://localhost:${PORT}`);
});
