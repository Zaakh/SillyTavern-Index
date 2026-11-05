# SillyTavern Extension Index

A browsable index of SillyTavern extensions on GitHub, including the many that are not in the official catalog. It shows popularity and whether each one is still maintained.

Page: _link follows once the repository is public and Pages is enabled_

## How it stays current

A GitHub Actions workflow (`.github/workflows/update.yml`) runs `scripts/update.mjs`:

- **refresh** (weekly, and on every push to `main` that touches `docs/`, `scripts/` or the workflow): updates the repos already known.
- **discover** (monthly): also searches GitHub for new extensions and for notable forks.

A repo counts as an extension only if its root `manifest.json` has `display_name` and `js`. Tests run first; if anything fails, nothing is committed. Changed data is committed to `docs/data/extensions.json`, the only place the facts are stored.

To run it by hand: Actions tab, "update", "Run workflow", pick the mode. Scheduled runs on a public repo can pause after 60 days without repo activity; a manual run is the fallback.

## Curating

Edit `docs/data/curated.json`: `exclude` and `include` (repos as `owner/repo`) are read by the update script; `tags` and `kind` are read by the page. The script never writes this file.

## Removal

If you maintain a listed extension and want it removed, open an issue or add it to `exclude` in a pull request.
