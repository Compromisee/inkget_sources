'use strict';

/**
 * Shared tag plumbing.
 *
 * Ten sites spell their vocabularies ten different ways, and a cached list can
 * outlive a fix to the parser that produced it. Everything here exists to make
 * a bad label impossible to keep: names are cleaned on the way in, and caches
 * carry a version so an old payload is thrown away instead of reused.
 */

const TAG_CACHE_VERSION = 3;
const MAX_TAG_LENGTH = 42;

/**
 * Sites that print "Crossdressing11Characters who dress…" in one link (a label,
 * a count and a blurb glued together) get rebuilt into just the label.
 */
function cleanTagName(raw) {
  let name = String(raw || '')
    .replace(/[\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A count glued to a following capitalised word: "Crossdressing11Characters".
  name = name.replace(/(?<=[a-z)\]])(\d{1,6})(?=[A-Z(])/g, ' ');

  // Same thing after the label itself: "Action 1200" → "Action".
  name = name.replace(/\s+\d{2,6}$/, '').trim();

  if (name.length > MAX_TAG_LENGTH) {
    // Long labels are almost always a blurb that swallowed the title; keep the
    // part before the first sentence break.
    const cut = name.split(/[.!?]\s|,\s(?=[a-z])/)[0];
    name = (cut || name).slice(0, MAX_TAG_LENGTH).trim();
  }

  return name.replace(/[\s,;:]+$/, '').trim();
}

/** A tag is usable when it is short, non-numeric and not a sentence. */
function isUsableTag(name) {
  const value = String(name || '').trim();
  if (!value || value.length > MAX_TAG_LENGTH) return false;
  if (!/[a-z]/i.test(value)) return false;
  if (/^(read|view|see|more)\b/i.test(value)) return false;
  return true;
}

/** Compare and match labels regardless of case, spacing and punctuation. */
const tagKey = (name) => String(name || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

/** URL-safe genre slug (Chikari uses underscores, the others hyphens). */
const tagSlug = (name, separator = '-') => tagKey(name).replace(/\s+/g, separator);

const cacheStore = new Map();

function readTagCache(key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (entry.version !== TAG_CACHE_VERSION) {
    cacheStore.delete(key);
    return null;
  }
  if (Date.now() - entry.at > entry.ttl) {
    cacheStore.delete(key);
    return null;
  }
  return entry.value;
}

function writeTagCache(key, value, ttl = 1000 * 60 * 60) {
  cacheStore.set(key, { version: TAG_CACHE_VERSION, at: Date.now(), ttl, value });
  return value;
}

/** Wipe every vocabulary; called from Settings when a source is toggled. */
function clearTagCache() {
  cacheStore.clear();
}

module.exports = {
  TAG_CACHE_VERSION,
  MAX_TAG_LENGTH,
  cleanTagName,
  isUsableTag,
  tagKey,
  tagSlug,
  readTagCache,
  writeTagCache,
  clearTagCache,
};
