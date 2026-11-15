'use strict';

const { createMadara } = require('./madara');

/** Manga Read — second Madara site, series live under /manga/<slug>/. */
module.exports = createMadara({
  id: 'mangaread',
  label: 'Manga Read',
  short: 'MR',
  homepage: 'https://www.mangaread.org',
  hosts: ['mangaread.org'],
  seriesPath: '/manga/',
  genrePath: '/genres/',
  genreIndexUrl: 'https://www.mangaread.org/?s=&post_type=wp-manga',
  genreBlocklist: ['genres'],
});
