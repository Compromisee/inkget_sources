'use strict';

/**
 * E-Hentai — galleries, searched with the site's own tag syntax.
 *
 *   https://e-hentai.org/?f_search=<query>&page=<n>      results
 *   https://e-hentai.org/g/<gid>/<token>/               one gallery
 *   https://e-hentai.org/s/<hash>/<gid>-<index>         one page
 *
 * Tags are namespaced (`female:collar`, `other:3d`, `parody:...`) and a query
 * is the same syntax the site uses: several tags separated by spaces mean AND,
 * a `$` suffix means OR, a `-` prefix excludes. The site has no public tag
 * directory, so the filter box accepts the namespace syntax directly and the
 * vocabulary here is the one actually observed while browsing, cached.
 */

const cheerio = require('cheerio');
const { fetchText } = require('../http');
const { cleanTagName } = require('./tag-utils');

const BASE = 'https://e-hentai.org';
const TAG_CACHE = 'ehentai.tags.v1';

/** Namespaces the site uses, so the filter can offer the prefixes. */
const NAMESPACES = ['female', 'male', 'other', 'mixed', 'language', 'parody', 'character', 'artist', 'group', 'reclass', 'cosplayer', 'studio'];

let observed = new Map();
let loaded = false;
// When the bulk walk last finished. Browsing also writes the cache, and that
// must not look like a completed harvest.
let harvestedAt = 0;

async function loadObserved() {
  if (loaded) return;
  loaded = true;
  try {
    const path = require('node:path');
    const os = require('node:os');
    const fs = require('node:fs/promises');
    const raw = JSON.parse(await fs.readFile(path.join(os.tmpdir(), `${TAG_CACHE}.json`), 'utf8'));
    (raw.items || []).forEach((entry) => observed.set(entry.name.toLowerCase(), entry));
    harvestedAt = Number(raw.harvestedAt) || 0;
  } catch {
    /* First run. */
  }
}

async function saveObserved() {
  try {
    const path = require('node:path');
    const os = require('node:os');
    const fs = require('node:fs/promises');
    const items = [...observed.values()];
    await fs.writeFile(
      path.join(os.tmpdir(), `${TAG_CACHE}.json`),
      JSON.stringify({ at: Date.now(), items, harvestedAt }),
      'utf8',
    );
  } catch {
    /* Caching is an optimisation. */
  }
}

/**
 * One request at a time, spaced out.
 *
 * E-Hentai answers a burst with a temporary IP ban, and a ban costs the user
 * every result for minutes, so the source itself paces its calls.
 */
const REQUEST_GAP = 420;
let requestChain = Promise.resolve();
let lastRequestAt = 0;

function polite(url, options) {
  const run = async () => {
    const wait = lastRequestAt + REQUEST_GAP - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fetchText(url, options);
  };
  const next = requestChain.then(run, run);
  requestChain = next.catch(() => null);
  return next;
}

const slugOf = (url = '') => String(url).match(/\/g\/(\d+)\/([a-z0-9]+)/i);

function parseInput(text = '') {
  const value = String(text).trim();
  const gallery = value.match(/e-hentai\.org\/g\/(\d+)\/([a-z0-9]+)/i);
  if (gallery) return { type: 'series', source: 'ehentai', id: gallery[1], slug: gallery[2] };
  const page = value.match(/e-hentai\.org\/s\/([a-z0-9]+)\/(\d+)-(\d+)/i);
  if (page) return { type: 'chapter', source: 'ehentai', id: page[2], slug: page[1], url: value };
  return null;
}

const titleOf = ($) => {
  const text = $('#gn').first().text().trim() || $('h1').first().text().trim();
  return text.replace(/\s+/g, ' ') || 'Untitled gallery';
};

/** Rows of the results table. */
function parseRows(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('table.itg tr').each((_, row) => {
    const link = $(row).find('td.gl3c a').first();
    const href = link.attr('href') || '';
    const match = href.match(/\/g\/(\d+)\/([a-z0-9]+)/i);
    if (!match) return;

    const title = link.find('.glink').first().text().trim() || $(row).find('.glink').first().text().trim();
    const tags = [];
    $(row).find('.gt').each((__, tag) => {
      const full = String($(tag).attr('title') || '').trim();
      if (full.includes(':')) tags.push(full.replace(':', ':'));
    });
    tags.forEach((tag) => {
      const name = cleanTagName(tag);
      if (name && !observed.has(name.toLowerCase())) observed.set(name.toLowerCase(), { name, slug: name });
    });

    const cover = $(row).find('img').first();
    const pageCount = Number(($(row).find('.gl5t').first().text() || '').replace(/[^\d]/g, '')) || null;

    items.push({
      source: 'ehentai',
      id: match[1],
      slug: match[2],
      title: title || `Gallery ${match[1]}`,
      url: `${BASE}/g/${match[1]}/${match[2]}/`,
      coverUrl: cover.attr('data-src') || cover.attr('src') || null,
      type: 'Gallery',
      status: null,
      year: null,
      // Every tag the row printed: narrowing by a second tag should never be a
      // matter of where it landed in the list.
      tags: [...new Set(tags)],
      language: (tags.find((tag) => tag.startsWith('language:')) || '').split(':')[1] || null,
      chapterCount: pageCount,
      latestChapter: null,
    });
  });

  if (items.length) saveObserved();
  return items;
}

/**
 * The site's search syntax, passed through untouched.
 *
 * A language is appended unless the query already names one, because the site
 * has no account-level language preference to inherit.
 */
function quoteTag(tag) {
  const value = String(tag).trim().replace(/\s+/g, ' ');
  if (!value) return '';
  // A tag with a space inside has to be quoted, otherwise the site reads each
  // word as its own AND term and returns the wrong galleries.
  if (/^-?[a-z]+:/.test(value)) {
    const [namespace, ...rest] = value.split(':');
    const name = rest.join(':').trim();
    return /\s/.test(name) ? `${namespace}:"${name}"` : `${namespace}:${name}`;
  }
  return /\s/.test(value) ? `"${value}"` : value;
}

function buildQuery(query, { language = 'english', tags = [] } = {}) {
  const parts = [String(query || '').trim(), ...(tags || []).map((tag) => String(tag).trim())]
    .filter(Boolean)
    .map((entry) => (/^\S+$/.test(entry) ? quoteTag(entry) : entry));
  const joined = parts.join(' ');
  if (language && language !== 'any' && !/language:/i.test(joined)) {
    return `${joined} language:${language}`.trim();
  }
  return joined;
}

/**
 * Pages of one search.
 *
 * The site pages by gallery id, not by number: each page carries its own
 * `next` link, so page N is reached by following N of them. The chain is kept
 * per query so scrolling deeper costs one request per page, not a fresh walk.
 */
const chains = new Map();
const CHAIN_TTL = 1000 * 60 * 15;

async function chainFor(search, upTo) {
  const key = search || '(front)';
  const cached = chains.get(key);
  const links = cached && Date.now() - cached.at < CHAIN_TTL ? cached.links : null;
  const list = links || [new URL(`${BASE}/?f_search=${encodeURIComponent(search)}`).toString()];
  if (!search) list[0] = `${BASE}/`;

  while (list.length <= upTo) {
    const html = await polite(list[list.length - 1]);
    const next = html.match(/href="(https:\/\/e-hentai\.org\/\?[^"]*next=\d+)"/)?.[1]?.replace(/&amp;/g, '&');
    if (!next) {
      chains.set(key, { at: Date.now(), links: list, done: true });
      return { links: list, done: true };
    }
    list.push(next);
  }
  chains.set(key, { at: Date.now(), links: list, done: false });
  return { links: list, done: false };
}

async function searchPage(query, { limit = 24, tags = [], language = 'english', page = 1 } = {}) {
  const search = buildQuery(query, { language, tags });
  const { links, done } = await chainFor(search, page - 1);
  const html = await polite(links[Math.min(page - 1, links.length - 1)]);
  const rows = parseRows(html);
  const items = rows.slice(0, limit);
  const hasNext = !done || Boolean(html.match(/href="[^"]*next=\d+"/));
  return { items, hasMore: hasNext };
}

async function search(query, options = {}) {
  const { items } = await searchPage(query, { ...options, page: 1 });
  return items;
}

/**
 * The library the site itself uses.
 *
 * There is no published tag directory, but every listing row carries the tags of
 * its gallery, so walking the two biggest result sets — everything translated,
 * and everything not — collects the vocabulary in bulk. The walk is capped,
 * cached for a week, and grows with the tags seen while browsing.
 */
// E-Hentai bans an IP that hammers it, so the walk stays small and paced; it
// grows with the tags seen while browsing instead.
const HARVEST_PAGES = 8;
const HARVEST_PAUSE = 550;
const HARVEST_TTL = 1000 * 60 * 60 * 24 * 7;

async function harvest() {
  if (harvestedAt && Date.now() - harvestedAt < HARVEST_TTL && observed.size > 500) return;

  const searches = ['language:english', '-language:english'];
  for (const search of searches) {
    let url = `${BASE}/?f_search=${encodeURIComponent(search)}`;
    for (let page = 0; page < HARVEST_PAGES; page += 1) {
      let html;
      try {
        html = await polite(url);
      } catch {
        break;
      }
      const before = observed.size;
      parseRows(html);
      await new Promise((resolve) => setTimeout(resolve, HARVEST_PAUSE));
      const next = html.match(/href="(https:\/\/e-hentai\.org\/\?[^"]*next=\d+)"/)?.[1]?.replace(/&amp;/g, '&');
      if (!next || observed.size === before) break;
      url = next;
    }
  }
  harvestedAt = Date.now();
  await saveObserved();
}

async function tags() {
  await loadObserved();
  await harvest();
  const list = [...observed.values()]
    .map((entry) => ({ name: entry.name, slug: entry.name, namespace: entry.name.split(':')[0] }))
    .filter((entry) => entry.name.includes(':') || entry.name.length > 1);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

async function getSeries(ref = {}) {
  const match = slugOf(ref.url || `https://e-hentai.org/g/${ref.id || ''}/${ref.slug || ''}/`);
  const gid = ref.id || match?.[1];
  const token = ref.slug || match?.[2];
  if (!gid || !token) throw new Error('That is not an E-Hentai gallery link.');

  const url = `${BASE}/g/${gid}/${token}/`;
  const html = await polite(url);
  const $ = cheerio.load(html);

  const title = titleOf($);
  const pages = Number(($('td:contains("Length")').next().text() || '').replace(/[^\d]/g, '')) || 0;
  const tags = [];
  // The tag list is a grid of divs whose ids are the canonical `namespace:tag`,
  // with underscores standing in for spaces.
  $('[id^="td_"]').each((_, cell) => {
    const id = String($(cell).attr('id') || '').replace(/^td_/, '');
    if (!id.includes(':')) return;
    const label = $(cell).find('a').first().text().trim();
    const name = (label || id.split(':').slice(1).join(':')).replace(/\s+/g, ' ').trim();
    if (!name) return;
    tags.push(`${id.split(':')[0]}:${name}`);
  });
  tags.forEach((tag) => {
    if (!observed.has(tag.toLowerCase())) observed.set(tag.toLowerCase(), { name: tag, slug: tag });
  });

  // The cover on a gallery page is a background image on a div inside #gd1.
  const cover =
    $('#gd1 img').first().attr('src') ||
    ($('#gd1 div').first().attr('style') || '').match(/url\((['"]?)([^'")]+)\1\)/)?.[2] ||
    $('#gdt img').first().attr('src') ||
    null;
  const posted = $('td:contains("Posted")').next().text().trim() || null;
  const languages = tags.filter((tag) => tag.startsWith('language:')).map((tag) => tag.split(':')[1]);
  const language = languages.find((value) => value !== 'translated') || languages[0] || null;

  return {
    source: 'ehentai',
    id: String(gid),
    slug: token,
    title,
    url,
    coverUrl: cover,
    type: 'Gallery',
    status: null,
    released: null,
    description: $('#gdd').text().replace(/\s+/g, ' ').trim().slice(0, 800) || '',
    authors: tags.filter((tag) => tag.startsWith('artist:')).map((tag) => tag.split(':')[1].replace(/_/g, ' ')),
    associatedNames: [],
    // Every tag the gallery carries: the page shows "+N more" rather than the
    // series losing the ones that sorted last.
    tags,
    language,
    adultContent: 'Yes',
    downloadName: title.replace(/[[\]]/g, '').slice(0, 80),
    // One gallery is one volume: its pages become the pages of a single chapter.
    chapters: pages
      ? [
          {
            source: 'ehentai',
            id: `${gid}`,
            name: `${pages} pages`,
            number: 1,
            url,
            official: false,
            publishedAt: posted,
            pages,
          },
        ]
      : [],
    chapterCount: pages ? 1 : 0,
    latestChapter: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Every page of a gallery.
 *
 * The gallery's thumbnail view is page-numbered (`?p=1`, `?p=2`, …) and each
 * thumbnail links to the viewer page that holds the real image, so the walk
 * collects the viewer links first and then reads them a few at a time instead of
 * following one long `next` chain.
 */
async function mapLimit(list, limit, worker) {
  const out = new Array(list.length);
  let index = 0;
  async function run() {
    while (index < list.length) {
      const current = index;
      index += 1;
      out[current] = await worker(list[current], current).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, run));
  return out;
}

async function getChapterImages(chapter = {}) {
  const url = String(chapter.url || '');
  const match = url.match(/e-hentai\.org\/g\/(\d+)\/([a-z0-9]+)/i);
  if (!match) throw new Error('That is not an E-Hentai gallery link.');

  const first = await polite(url);
  const pages = Number((first.match(/Length:<\/td>\s*<td[^>]*>\s*([\d,]+)/i)?.[1] || '').replace(/,/g, '')) || 0;

  const viewerLinks = new Set(
    [...first.matchAll(/href="(https:\/\/e-hentai\.org\/s\/[a-z0-9]+\/\d+-\d+)"/g)].map((entry) => entry[1]),
  );

  // Thumbnail pages carry the rest; each holds about forty links.
  const perPage = 40;
  const thumbnailPages = Math.min(80, Math.ceil(Math.max(pages, viewerLinks.size) / perPage));
  for (let page = 1; page < thumbnailPages; page += 1) {
    const html = await polite(`${url}?p=${page}`).catch(() => '');
    [...html.matchAll(/href="(https:\/\/e-hentai\.org\/s\/[a-z0-9]+\/\d+-\d+)"/g)].forEach((entry) =>
      viewerLinks.add(entry[1]),
    );
  }

  const ordered = [...viewerLinks].sort((a, b) => {
    const indexOf = (value) => Number(value.match(/-(\d+)$/)?.[1] || 0);
    return indexOf(a) - indexOf(b);
  });

  const images = (
    await mapLimit(ordered, 5, async (link) => {
      const page = await polite(link);
      return page.match(/<img id="img"[^>]*src="([^"]+)"/)?.[1] || null;
    })
  ).filter(Boolean);

  if (!images.length) throw new Error('No pages found for this gallery.');
  return { images, referer: url };
}

async function trending({ limit = 24 } = {}) {
  const html = await polite(`${BASE}/?f_search=language:english`);
  return parseRows(html).slice(0, limit);
}

async function recommendations({ limit = 12 } = {}) {
  return trending({ limit });
}

module.exports = {
  id: 'ehentai',
  label: 'E-Hentai',
  short: 'EH',
  homepage: BASE,
  hosts: ['e-hentai.org'],
  hasTags: true,
  namespaces: NAMESPACES,
  parseInput,
  search,
  searchPage,
  tags,
  getSeries,
  getChapterImages,
  trending,
  recommendations,
};
