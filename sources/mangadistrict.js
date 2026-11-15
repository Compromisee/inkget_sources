'use strict';

const { createMadara } = require('./madara');

/** Manga District — Madara/Manhwa site, series live under /series/<slug>/. */
module.exports = createMadara({
  id: 'mangadistrict',
  label: 'Manga District',
  short: 'MD',
  homepage: 'https://mangadistrict.com',
  hosts: ['mangadistrict.com'],
  seriesPath: '/series/',
  genrePath: '/publication-genre/',
  genreIndexUrl: 'https://mangadistrict.com/',
  // The front page leans adult; start the picks from a mainstream genre.
  recommendGenre: 'action',
});
