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
four times per day (every 6 hours, on the hour) and generates:

- `channels.m3u` — a merged M3U playlist sourced from
  [iptv-org](https://github.com/iptv-org/iptv) (categories, countries, regions),
  filtered to include only channels with "1080p" in their name.
  - For most sources (News, Sports, etc.): additionally filtered to India-only channels (`.in` tvg-id)
  - For Samsung India source: all 1080p channels are included (no India filter)
- `epg.xml` — a matching EPG (XMLTV) file for the same channels.

The generated files are published to **GitHub Pages** at
<https://node-bug.github.io/ch/channels.m3u> and
<https://node-bug.github.io/ch/epg.xml> — no commit is made to the repo.
#### Run it manually

Open **Actions → Daily TV Guide → Run workflow**. Available inputs:

| Input | Default | Purpose |
| --- | --- | --- |
| `verify` | `true` | Probe each stream URL and drop dead ones |

After the run completes, the **deploy** job publishes the files to the
Pages site; the workflow run summary links straight to the new
`channels.m3u` / `epg.xml`. To disable verification (faster but
riskier), set `verify=false`.
### Sources

The generator currently fetches playlists from the following iptv-org sources:
- Categories: News, Sports, Movies, Entertainment, Music, Documentary
- Countries: US, UK, IN, AU, CA
- Worldwide: WW region
- Samsung India: in_samsung.m3u

### Filtering

The final list is filtered to include only channels with "1080p" in their name:
- For most sources (News, Sports, etc.): additionally filtered to India-only channels (`.in` tvg-id)
- For Samsung India source: no additional India filter (all 1080p channels included)

### Regenerate locally

```bash
node scripts/generate.js
```

### Verify channels actually work

The `scripts/verify.js` module probes each stream URL and keeps only the ones
that respond. It's used automatically by the daily CI job, and can be invoked
locally in two ways:

```bash
# Generate + verify in one pass — only working channels end up in channels.m3u
node scripts/generate.js --verify

# Verify an existing playlist directly
node scripts/verify.js channels.m3u
```

Verification uses a HEAD request (with a ranged-GET fallback for servers that
reject HEAD) and a short timeout, so it's safe to run in CI. Tune with:

| Env var | Default | Purpose |
| --- | --- | --- |
| `VERIFY_TIMEOUT_MS` | `6000` | Per-request timeout |
| `VERIFY_CONCURRENCY` | `8` | Max parallel probes |

> Note: reachable ≠ perfectly working. Some streams respond OK but stall at
> playback time. For stricter validation, pipe the first ~256 KB through
> `ffprobe` to confirm a real media container.

## License

MIT