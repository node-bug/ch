# ch

A simple M3U playlist parser and generator for Node.js.

## Features

- Parse M3U playlist files
- Generate M3U playlist files
- Support extended M3U format with metadata

## Installation

```bash
npm install ch
```

## Usage

### Parse a playlist

```js
const ch = require('ch');

const playlist = ch.parse('./channels.m3u');
console.log(playlist);
```

### Generate a playlist

```js
const ch = require('ch');

const playlist = {
  title: 'My Playlist',
  tracks: [
    { title: 'Track 1', path: './track1.mp3', duration: 200 },
    { title: 'Track 2', path: './track2.mp3', duration: 180 }
  ]
};

ch.generate('./channels.m3u', playlist);
```

## Daily TV Guide (CI)

A GitHub Actions workflow (`.github/workflows/daily-guide.yml`) runs
four times per day (every 6 hours, on the hour) and runs
`scripts/fetch-iptvcat-india.js` to produce:

- `channels.m3u` — a curated Indian-channel M3U playlist sourced from
  [iptvcat.net/india__1](https://iptvcat.net/india__1).
- `epg.xml` — a matching EPG (XMLTV) file for the same channels.

The generated files are published to **GitHub Pages** at
<https://node-bug.github.io/ch/channels.m3u> and
<https://node-bug.github.io/ch/epg.xml> — no commit is made to the repo.

#### Run it manually

Open **Actions → Daily TV Guide → Run workflow**. Available inputs:

| Input | Default | Purpose |
| --- | --- | --- |
| `verify` | `true` | Probe each stream URL and drop dead ones (passed through as `--no-verify` when off) |

After the run completes, the **deploy** job publishes the files to the
Pages site; the workflow run summary links straight to the new
`channels.m3u` / `epg.xml`. To disable verification (faster but
riskier), set `verify=false`.

### Sources

The CI generator uses [iptvcat.net/india__1](https://iptvcat.net/india__1) as its
single source. The legacy `scripts/generate.js` script (still runnable
locally) merges playlists from
[iptv-org](https://github.com/iptv-org/iptv) instead:
- Categories: News, Sports, Movies, Entertainment, Music, Documentary
- Countries: US, UK, IN, AU, CA
- Worldwide: WW region

### Filtering

`scripts/generate.js` (iptv-org) filters to channels whose name contains
"1080p" and, for most sources, an India-only tvg-id (`.in`). This
script is no longer used by CI but is kept for local experimentation.

`scripts/fetch-iptvcat-india.js` (the active CI generator) deduplicates
by URL and by base name, drops low-resolution variants (≤ 576p / SD),
and prefers 1080p siblings when duplicates exist.

### Regenerate locally

```bash
node scripts/fetch-iptvcat-india.js         # CI-compatible Indian playlist
node scripts/generate.js                    # iptv-org-based legacy generator
node scripts/generate.js --no-verify        # Skip stream probing
```

### Generate Indian channels only

For a focused collection of Indian channels, you can run the dedicated Indian IPTV fetcher:

```bash
node scripts/fetch-iptvcat-india.js
```

This script fetches channels from iptvcat.net/india__1 and generates both channels.m3u and epg.xml with enhanced Indian channel filtering. The script:

- Deduplicates by URL and by normalized base name (so "&TV (1080p)" and "&TV (576p)" don't both end up in the playlist).
- Drops low-resolution channels (anything ≤ 576p / SD).
- Prefers the 1080p variant when both 1080p and 720p exist for the same channel.
- Optionally probes every remaining stream URL to drop dead / placeholder ones (on by default).

Flags:

```bash
# Skip per-URL verification (faster, but every channel is kept)
node scripts/fetch-iptvcat-india.js --no-verify

# Show CLI help
node scripts/fetch-iptvcat-india.js --help
```

Env vars (used when verification is enabled):

| Env var | Default | Purpose |
| --- | --- | --- |
| `VERIFY_TIMEOUT_MS` | `8000` | Per-request timeout |
| `VERIFY_CONCURRENCY` | `8` | Max parallel probes |
| `BASE_URL` | _(empty)_ | When set, the generated M3U header gets a `url-tvg="<BASE_URL>/epg.xml"` attribute so players can auto-discover the EPG |

If `BASE_URL` is set, the generated M3U gets a `url-tvg="<BASE_URL>/epg.xml"`
header so players can auto-discover the matching EPG.

### Verify channels actually work

Verification is built into both scripts and is enabled by default:

- `scripts/fetch-iptvcat-india.js` — the active generator. Verifies every remaining stream URL on every run.
- `scripts/generate.js` — the legacy iptv-org-based generator. Also runs a HEAD probe on every stream (disable with `--no-verify`) and additionally validates every logo URL (disable with `--no-verify-icons`).

Both honour `VERIFY_TIMEOUT_MS` and `VERIFY_CONCURRENCY`.

> Note: `scripts/verify.js` does not currently exist. Verification is handled directly by the generators above.

## License

MIT