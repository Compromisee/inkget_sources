# Inkget source repository

This separate local repository contains source adapters, shared helpers, and `assets/catalogue/indexes/public/sources.ts`, the catalogue of public source links. `sources.json` is the index Inkget reads; the TypeScript catalogue is not the install URL.

## Add the sources to Inkget

**There is no public Inkget repository URL yet.** This repository has not been published and has no configured remote.

For the copy in this workspace:

1. In Inkget, open **Sources → repositories**.
2. Choose **local file** and select `/home/user/inkget-sources/sources.json`. If you moved the repository, select `sources.json` in its new location instead.
3. The sources appear without restarting. Only add the repository if you trust its code.

The equivalent URL for this workspace is `file:///home/user/inkget-sources/sources.json`. That path only works where this copy exists; a different computer will have a different path.

If you publish the repository, host `sources.json` and the `sources/` directory together, then enter the actual **HTTPS URL of the raw `sources.json` file** in Inkget. Do not use a repository web page or the `sources.ts` file as the index URL.

Update and remove repositories in the same panel. Finish or cancel their queued downloads first. Removing a repository also removes its sources' bookmarks; downloaded files are kept.

## Trust and maintenance

Repository modules run with Inkget's application permissions. SHA-256 hashes detect corruption, not a malicious author. Only add repositories you trust.

If a module changes, update its SHA-256 in `sources.json` before refreshing the repository in Inkget. The index also marks sources concealed until the reveal gesture and includes the optional extension hook.

MIT licensed; see `LICENSE`.
