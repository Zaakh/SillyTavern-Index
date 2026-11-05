# SillyTavern Extension Index

A browsable, searchable index of [SillyTavern](https://github.com/SillyTavern/SillyTavern) extensions on GitHub, including the many that are not in the official catalog. For each extension it shows popularity, how recently it was updated and what language its documentation is in, so you can tell what exists and what is still maintained.

Page: _link follows once Pages is enabled_

## What you can do on the page

- Sort by stars, last commit, name, forks or open issues, and search by name, owner, description or tag.
- Filter by health (Active within 3 months, Slow within 12, Stale beyond, or Archived), official catalog membership, kind (extension, theme, unspecified), documentation language and a minimum star count. The default hides entries under 5 stars.
- See forks that have their own development next to their parent, and filter to one family.
- Share a view: filters and sort live in the page URL.

## Where the data comes from

- A repository counts as an extension only if its root `manifest.json` has `display_name` and `js`, which is what SillyTavern itself requires.
- Stars, forks, open issues and the date of the last commit on the default branch come from the GitHub API. The default branch is what users install, so its last commit is the activity date.
- Forks are listed on their own only if they are ahead of their parent, have at least 5 stars and were committed to after they were created.
- Kind and documentation language are guesses made once when an entry is added: kind from the name, description and README, language by running [tinyld](https://github.com/komodojp/tinyld) over the README text. Unclear cases stay `unspecified` or unknown. They can be corrected in `docs/data/curated.json`.
- Email addresses found in manifests are removed.

All facts live in one file, `docs/data/extensions.json`. Nothing else repeats them.

## How it stays current

A GitHub Actions workflow (`.github/workflows/update.yml`) runs `scripts/update.mjs`:

- **refresh** (weekly, and on every push to `main` that touches `docs/`, `scripts/`, `package*.json` or the workflow): updates the entries already known.
- **discover** (monthly): also searches GitHub for new extensions and for notable forks. It takes about 11 minutes because of GitHub's search rate limit.

The tests run first. If anything fails, or GitHub returns an error for a known repository, the run fails and nothing is committed. A repository is marked gone only when GitHub explicitly says it does not exist. Changed data is committed by the workflow; unchanged data produces no commit.

To run it by hand: Actions tab, "update", "Run workflow", pick the mode. Scheduled runs on a public repository can pause after 60 days without repository activity; a manual run is the fallback.

## Working on it locally

Needs Node 24.

```
npm ci
node --test
GH_TOKEN=$(gh auth token) node scripts/update.mjs refresh
```

To preview the page, serve the `docs/` folder with any static file server. The only dependency is `tinyld`.

## Curating

Edit `docs/data/curated.json`:

- `exclude` and `include` (repositories as `owner/repo`) are read by the update script.
- `kind` (a repository mapped to `extension`, `theme` or `unspecified`) and `tags` are read by the page. A `kind` here overrides the guess.

The script never writes this file. Pull requests are welcome.

## Removal

If you maintain a listed extension and want it removed, open an issue or add it to `exclude` in a pull request.

## License

Apache License 2.0, see [LICENSE](LICENSE).
