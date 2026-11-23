# Make an Inkget source and repository

Inkget source repositories are collections of JavaScript adapters. An adapter translates a site's search, series and chapter pages into the data Inkget uses. Add only sites and content you have permission to access; don't bypass paid chapters, authentication or access controls. A repository is trusted code, not a sandbox.

## 1. Make a repository

Create a folder with an index and a `sources` directory:

```text
my-repository/
  sources.json
  sources/
    mysite.js
```

The index and `sources/` must be next to each other, even when hosted. The example below is a **template**, not a working source. Replace the example ID, name, homepage and SHA-256 with your own. The ID must match the adapter's `id`, and must not already be installed from another repository.

```json
{
  "format": "inkget-source-repository-v1",
  "version": 1,
  "sources": [
    {
      "id": "mysite",
      "name": "My Site",
      "homepage": "https://example.com",
      "module": "sources/mysite.js",
      "hidden": false
    }
  ],
  "files": {
    "sources/mysite.js": "REPLACE_WITH_SHA256"
  },
  "extensions": []
}
```

IDs may contain letters, numbers, `_` and `-` (up to 80 characters). Don't use the reserved `aidoku-` prefix. Module paths must be `sources/<filename>.js`, with letters, numbers, `_` or `-` in the filename. List **every** adapter and local helper under `files`, including helpers loaded with `require('./helper')`; each value must be the SHA-256 of that exact file. Module paths and hashes are checked when adding or updating. If multiple repositories provide the same source ID, the second installation is rejected.

## 2. Write an adapter

Use CommonJS (`module.exports`) in `sources/mysite.js`. The loader checks for `id`, `label`, `homepage`, a `hosts` array, and the functions `parseInput`, `search` and `getSeries`. Reading and downloading also require `getChapterImages`. This scaffold deliberately throws until you implement the real site-specific requests and parsing:

```js
'use strict';
const ID = 'mysite';
const BASE = 'https://example.com'; // Replace with your site.

module.exports = {
  id: ID,
  label: 'My Site',
  short: 'MS',
  homepage: BASE,
  hosts: ['example.com'],
  hasTags: false,

  // Return null if the input is not a supported URL. For a recognized series,
  // return { type: 'series', source: ID, id, url }.
  parseInput(text) { return null; },

  // Return an array of { source: ID, id, title, url, coverUrl, authors, tags }.
  async search(query, { limit, tags, language } = {}) {
    throw Error('Implement site search');
  },

  // Return the series metadata and a chapters array. Chapters should have
  // { source: ID, id, titleId, name, number, url }.
  async getSeries(ref) {
    throw Error('Implement series and chapters');
  },

  // Return { images: [absolute image URLs], referer: chapter.url }.
  async getChapterImages(chapter) {
    throw Error('Implement chapter pages');
  },
};
```

For a working implementation and real return shapes, read `sources/webtoons.js` or `sources/chikari.js`. Useful optional methods include `searchPage(query, { limit, tags, page, language })`, returning `{ items, hasMore }`, and `tags()`, returning tag objects such as `{ name, slug }`. Set `hasTags: true` only if you implement tags; support multiple selected tags where the site allows it. `resolveChapter(ref)` can map a pasted chapter link to its parent series. Include stable source and chapter IDs and preserve page ordering. Validate external URLs and hosts before making requests.

The runtime can load declared local helpers with `require('./helper')`. Inkget exposes `../http`, `../prefs-store`, `../reader-prefs`, and `../summary`; `cheerio` and other modules already provided by the app can be required, but your repository cannot install arbitrary npm dependencies for Inkget. Don't depend on undeclared packages or private app internals. Provider code runs with app privileges.

## 3. Hash the files

For a single adapter, Node.js can print the hash on Windows, macOS or Linux:

```sh
node -e "const fs=require('fs'),c=require('crypto'); console.log(c.createHash('sha256').update(fs.readFileSync('sources/mysite.js')).digest('hex'))"
```

Run that in your repository folder and copy the output into `files`. Repeat for every listed helper. Or copy this repository's `scripts/update-hashes.cjs` into your repository's `scripts/` folder, declare all paths in `files` first, then run:

```sh
node scripts/update-hashes.cjs sources.json
```

The script updates existing entries only; it does not discover files or add sources. Recalculate hashes after every adapter or helper edit. Hashes detect corruption, not a malicious author.

## 4. Test and publish

1. In Inkget, open **Sources → repositories & sources**, select **Inkget**, choose **local file**, and select your `sources.json`.
2. Enable the source under **installed**. Test search and pagination, pasted links, tags if supported, series metadata, chapters, reading and downloading. Test error handling and unavailable or locked chapters. A successfully loaded index alone does not prove an adapter works.
3. Host the index and the `sources/` folder together on HTTPS. Files must be served from the same origin as the index, with no redirects. Give users the **raw HTTPS URL to `sources.json`**, not a GitHub repository page, HTML page or TypeScript file. Verify the actual URLs and branch after publishing; this repository's GitHub page is not itself an installable index.
4. After edits, update hashes and use the repository's update button in Inkget. Finish or cancel active downloads first. Removing a repository or removing a source from an updated index also removes affected bookmarks; downloaded files are kept.

Inkget adapters and Aidoku source lists are different formats. Select the matching repository type in Inkget; an Aidoku list is not an Inkget `sources.json`.
