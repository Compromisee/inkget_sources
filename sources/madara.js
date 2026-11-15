'use strict';

/**
 * Generic WP-Manga ("Madara" theme) source.
 *
 * Most of the sites that run this theme share markup: listing cards live in
 * `.page-item-detail` (or `.c-tabs-item__content` on search pages), the series
 * page carries `.wp-manga-chapter` rows, and chapters hide their pages behind
 * `.reading-content img`. A new Madara site is just a config object.
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');

const GENERIC_TAGS = /^(genre|genres|manga|manhwa|manhua|comic|comics)$/i;

function absolute(url, base) {
  const value = String(url || '').trim();
  if (!value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `${base.replace(/\/$/, '')}${value}`;
  return `${base.replace(/\/$/, '')}/${value}`;
}

/** Madara lazily loads covers, so look past `src` (often a placeholder svg). */
function coverFrom(scope) {
  const image = scope.find('img').first();
  if (!image.length) return null;
  // Lazyload themes park a placeholder in `src` and the real cover in a data
  // attribute (or in the largest srcset entry), so those come first.
  const isPlaceholder = (value) => /dflazy|lazy|placeholder|blank\.(gif|png)|spacer/i.test(value);
  const candidates = [
    'data-src',
    'data-lazy-src',
    'data-default-src',
    'data-mature-static',
    'data-original',
    'lazy-src',
    'src',
  ];
  for (const attr of candidates) {
    const value = image.attr(attr);
    if (value && !/^data:image\//i.test(value) && !isPlaceholder(value)) return value.trim();
  }
  const srcset = image.attr('data-srcset') || image.attr('srcset') || scope.find('source[srcset]').first().attr('srcset');
  if (srcset) {
    const widest = srcset
      .split(',')
      .map((part) => part.trim().split(/\s+/))
      .filter((parts) => parts[0] && !isPlaceholder(parts[0]))
      .sort((a, b) => (Number(String(b[1] || '').replace(/\D/g, '')) || 0) - (Number(String(a[1] || '').replace(/\D/g, '')) || 0))[0];
    if (widest) return widest[0];
  }
  return null;
}

function chapterNumberFromName(name = '') {
  const match = String(name).match(/(?:chapter|ch\.?|episode|ep\.?)\s*#?\s*([\d.]+)/i);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  const numbers = String(name).match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;
  const value = Number(numbers[numbers.length - 1]);
  return Number.isFinite(value) ? value : null;
}

const slugify = (name = '') =>
  String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function createMadara(config) {
  const {
    id,
    label,
    short,
    homepage: BASE,
    hosts = [],
    seriesPath = '/series/',
    genrePath = '/publication-genre/',
    genreIndexUrl = BASE,
    genreBlocklist = [],
    recommendGenre = null,
  } = config;

  const seriesUrl = (slug) => `${BASE}${seriesPath}${slug}/`;
  const seriesHrefRe = new RegExp(`${seriesPath.replace(/\//g, '\\/')}([a-z0-9-]+)`, 'i');
  const chapterHrefRe = new RegExp(`${seriesPath.replace(/\//g, '\\/')}([a-z0-9-]+)\\/chapter-([a-z0-9-]+)`, 'i');

  const slugFromUrl = (url = '') => String(url).match(seriesHrefRe)?.[1] || null;

  function parseInput(text = '') {
    const value = String(text).trim();
    const chapter = value.match(chapterHrefRe);
    if (chapter) {
      return {
        type: 'chapter',
        source: id,
        id: `${chapter[1]}/chapter-${chapter[2]}`,
        slug: chapter[1],
        url: seriesUrl(chapter[1]) + `chapter-${chapter[2]}/`,
      };
    }
    const series = value.match(seriesHrefRe);
    if (!series) return null;
    return { type: 'series', source: id, id: series[1], slug: series[1], url: seriesUrl(series[1]) };
  }

  /* ---------------------------------------------------------- listing -- */

  function parseCards(html) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    $('.page-item-detail, .c-tabs-item__content').each((_, element) => {
      const card = $(element);
      const link = card.find('.post-title a').first().length
        ? card.find('.post-title a').first()
        : card.find(`a[href*="${seriesPath}"]`).first();
      const href = link.attr('href') || '';
      const slug = slugFromUrl(href);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);

      const title = (link.text().trim() || link.attr('title') || card.find('img').first().attr('alt') || '').trim();
      const tags = card
        .find('a[href*="genre"]')
        .map((__, anchor) => $(anchor).text().trim())
        .get()
        .filter((name) => name && !GENERIC_TAGS.test(name));

      results.push({
        source: id,
        id: slug,
        title: title || 'Untitled',
        slug,
        url: absolute(href, BASE),
        coverUrl: absolute(coverFrom(card.find('.item-thumb').length ? card.find('.item-thumb') : card), BASE),
        type: 'Manhwa',
        year: (card.find('.release-year, .mg_release .summary-content').first().text().match(/\b(19|20)\d{2}\b/) || [])[0] || null,
        status: card.find('.mg_status .summary-content').first().text().trim() || null,
        tags: [...new Set(tags)].slice(0, 8),
        latestChapter: card.find('.list-chapter .chapter-item a, .latest-chap a').last().text().trim() || null,
      });
    });

    return results;
  }

  /* ------------------------------------------------------------- tags -- */

  let tagCache = null;

  async function tags() {
    if (tagCache && Date.now() - tagCache.at < 60 * 60 * 1000) return tagCache.tags;
    const html = await fetchText(genreIndexUrl);
    const $ = cheerio.load(html);
    const pattern = new RegExp(`${genrePath.replace(/\//g, '\\/')}([a-z0-9-]+)`, 'i');
    const seen = new Map();

    $('a').each((_, anchor) => {
      const href = $(anchor).attr('href') || '';
      const slug = href.match(pattern)?.[1];
      if (!slug || seen.has(slug) || genreBlocklist.includes(slug)) return;
      const name = ($(anchor).attr('title') || $(anchor).text() || slug).trim().replace(/\s+/g, ' ');
      if (!name || GENERIC_TAGS.test(name)) return;
      seen.set(slug, { name, slug });
    });

    const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    tagCache = { at: Date.now(), tags: list };
    return list;
  }

  async function resolveTagSlugs(names = []) {
    if (!names.length) return [];
    const list = await tags().catch(() => []);
    return names
      .map((name) => {
        const key = String(name).toLowerCase();
        const hit =
          list.find((entry) => entry.name.toLowerCase() === key) ||
          list.find((entry) => entry.slug === slugify(name));
        return hit?.slug || slugify(name);
      })
      .filter(Boolean);
  }

  /* ----------------------------------------------------------- search -- */

  const searchCache = new Map();
  const SEARCH_TTL = 60 * 1000;

  /** One page of results, plus whether the site says there is another. */
  async function searchPage(query, { limit = 24, tags: wanted = [], page = 1 } = {}) {
    const text = String(query || '').trim();
    const slugs = await resolveTagSlugs(wanted);

    const params = new URLSearchParams();
    params.set('s', text);
    params.set('post_type', 'wp-manga');
    if (page > 1) params.set('paged', String(page));
    slugs.forEach((slug) => params.append('genre[]', slug));

    const html = await fetchText(`${BASE}/?${params.toString()}`);
    const all = parseCards(html);
    const items = all.slice(0, limit);
    // These themes print 20 cards per page and no pager markup on search pages,
    // so a full page means there is probably another one.
    const hasMore =
      items.length >= Math.min(limit, 20) ||
      new RegExp(`[?&]paged=${page + 1}(?![0-9])`).test(html) ||
      new RegExp(`/page/${page + 1}/?(?![0-9])`).test(html);
    return { items, hasMore };
  }

  async function search(query, { limit = 24, tags: wanted = [] } = {}) {
    const text = String(query || '').trim();
    const slugs = await resolveTagSlugs(wanted);
    const key = `${id}:${text.toLowerCase()}::${[...slugs].sort().join('|')}`;
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.results;

    const { items: results } = await searchPage(query, { limit, tags: wanted, page: 1 });

    searchCache.set(key, { at: Date.now(), results });
    if (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value);
    return results;
  }

  /* ----------------------------------------------------------- series -- */

  function metaValue($, heading) {
    let value = '';
    $('.post-content_item').each((_, element) => {
      const item = $(element);
      const label = item.find('.summary-heading').first().text().trim().toLowerCase();
      if (label !== heading.toLowerCase()) return;
      value = item.find('.summary-content').first().text().trim().replace(/\s+/g, ' ');
    });
    return value || null;
  }

  function parseChapterList($) {
    const chapters = [];
    const seen = new Set();

    $('.wp-manga-chapter a, .listing-chapters_wrap a[href*="/chapter"]').each((_, anchor) => {
      const href = anchor ? $(anchor).attr('href') : '';
      if (!href || seen.has(href)) return;
      const name = $(anchor).text().trim().replace(/\s+/g, ' ');
      if (!name) return;
      seen.add(href);
      const token = href.match(/chapter-([a-z0-9-]+)/i)?.[1] || href;
      chapters.push({
        source: id,
        id: token,
        name,
        number: chapterNumberFromName(name),
        url: absolute(href, BASE),
        official: false,
        publishedAt:
          $(anchor).closest('li').find('.chapter-release-date .timediff, .chapter-release-date i').first().text().trim() || null,
      });
    });

    chapters.sort((a, b) => {
      if (a.number == null && b.number == null) return 0;
      if (a.number == null) return 1;
      if (b.number == null) return -1;
      return a.number - b.number;
    });
    return chapters;
  }

  async function getSeries(ref = {}) {
    const slug = ref.slug || ref.id || slugFromUrl(ref.url || '');
    // A chapter link should still open its parent series.
    const url = slug ? seriesUrl(slug) : ref.url;
    if (!url) throw new Error(`That is not a ${label} series link.`);

    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const title =
      $('.post-title h1').first().text().trim() ||
      $('h1').first().text().trim() ||
      ($('meta[property="og:title"]').attr('content') || '').trim();

    const description = [
      $('.description-summary .summary__content p').map((_, node) => $(node).text().trim()).get().join(' '),
      $('.description-summary').first().text().trim(),
    ]
      .find((value) => value && value.length > 20) || '';

    const authors = $('.author-content a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const artists = $('.artist-content a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const genreNames = $('.genres-content a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const associatedNames = (metaValue($, 'Alternative') || '')
      .split(/\s*[,|]\s*/)
      .map((value) => value.trim())
      .filter(Boolean);

    const chapters = parseChapterList($);

    return {
      source: id,
      id: slug || slugFromUrl(url),
      slug: slug || slugFromUrl(url),
      title: title || 'Untitled',
      url: absolute(url, BASE),
      coverUrl: absolute(
        coverFrom($('.summary_image').length ? $('.summary_image') : $('.post-title').first().parent()) ||
          $('meta[property="og:image"]').attr('content'),
        BASE,
      ),
      description: description.replace(/\s+/g, ' ').trim().slice(0, 1200),
      authors: authors.length ? authors : artists,
      tags: [...new Set(genreNames)].slice(0, 12),
      associatedNames,
      type: 'Manhwa',
      status: metaValue($, 'Status'),
      released: metaValue($, 'Release'),
      officialTranslation: null,
      animeAdaptation: null,
      adultContent: genreNames.some((tag) => /adult|mature|smut|erotica|ecchi/i.test(tag)) ? 'Yes' : 'No',
      related: [],
      chapters,
      chapterCount: chapters.length,
      latestChapter: chapters.length ? chapters[chapters.length - 1] : null,
      fetchedAt: new Date().toISOString(),
    };
  }

  /* ---------------------------------------------------------- chapter -- */

  async function getChapterImages(chapter = {}) {
    const html = await fetchText(chapter.url);
    const $ = cheerio.load(html);
    const images = [];

    const scope = $('.reading-content').length ? $('.reading-content') : $('body');
    scope.find('img').each((_, image) => {
      const node = $(image);
      const src = (node.attr('data-src') || node.attr('src') || node.attr('data-lazy-src') || '').trim();
      if (!src || /^data:image\//i.test(src)) return;
      const url = absolute(src, BASE);
      // Theme assets (reader chrome, watermarks) sit under /assets/, not /publication/.
      if (!url || /\/assets\//i.test(url)) return;
      if (!images.includes(url)) images.push(url);
    });

    if (!images.length) throw new Error('No pages found for this chapter.');
    return { images, referer: `${BASE}/` };
  }

  /* --------------------------------------------------- recommendations -- */

  // Cover pages lead with adult serials; keep those out of the default picks.
  const ADULT = /uncensored|\b18\+|hentai|smut|nsfw/i;

  /** Trending: the site's view-ranked listing, adult serials filtered out. */
  async function trending({ limit = 24 } = {}) {
    const params = new URLSearchParams({ s: '', post_type: 'wp-manga', orderby: 'views' });
    if (recommendGenre) params.append('genre[]', recommendGenre);
    const html = await fetchText(`${BASE}/?${params.toString()}`);
    const all = parseCards(html);
    const clean = all.filter((item) => !ADULT.test(item.title));
    return (clean.length >= 6 ? clean : all).slice(0, limit);
  }

  async function recommendations({ limit = 12 } = {}) {
    const params = new URLSearchParams({ s: '', post_type: 'wp-manga' });
    if (recommendGenre) params.append('genre[]', recommendGenre);
    const html = await fetchText(`${BASE}/?${params.toString()}`);
    const all = parseCards(html);
    const clean = all.filter((item) => !ADULT.test(item.title));
    // If the site is mostly adult-tagged, still show something.
    return (clean.length >= 6 ? clean : all).slice(0, limit);
  }

  return {
    id,
    label,
    short,
    homepage: BASE,
    hosts,
    parseInput,
    slugFromUrl,
    seriesUrl,
    chapterNumberFromName,
    hasTags: true,
    search,
    searchPage,
    tags,
    getSeries,
    getChapterImages,
    recommendations,
    trending,
  };
}

module.exports = { createMadara, absolute, chapterNumberFromName, slugify };
