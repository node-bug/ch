# ch

A small Node.js CLI that builds a curated Indian IPTV playlist and
matching EPG from public [iptv-org](https://github.com/iptv-org/iptv)
sources.

## Features

- Merges multiple iptv-org playlists (categories + India + worldwide) and deduplicates by stream URL
- Filters to India-only 1080p channels (configurable)
- Probes every stream URL and every logo URL with bounded concurrency and drops dead ones
- Writes both `channels.m3u` and a 24-hour EPG (`epg.xml`)
- Zero third-party dependencies — uses only Node built-ins

## Installation

```bash
npm install
```

## Usage

`scripts/generate.js` is the only script. It writes `channels.m3u` and
`epg.xml` to the repository root.

```bash
node scripts/generate.js                 # Full run with verification
node scripts/generate.js --no-verify     # Skip stream probing
node scripts/generate.js --no-verify-icons  # Skip logo probing
```

The exported helpers (`parseExtinf`, `buildPlaylistFromText`, `buildEpg`,
`writeM3u`, …) can also be `require()`'d directly for one-off parsing:

```js
const { buildPlaylistFromText, buildEpg } = require('./scripts/generate');
const channels = buildPlaylistFromText(fs.readFileSync('channels.m3u', 'utf-8'));
const epg = buildEpg(channels, new Date());
```

## Daily TV Guide (CI)

A GitHub Actions workflow (`.github/workflows/daily-guide.yml`) runs
four times per day (every 6 hours, on the hour) and runs
`scripts/generate.js` to produce:

- `channels.m3u` — a merged M3U playlist sourced from
  [iptv-org](https://github.com/iptv-org/iptv) (categories + India + worldwide).
  - Filtered to include only channels with "1080p" in their name and an
    India-only `tvg-id` (matches `.in` / `.in@<region>`).
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

The generator pulls from [iptv-org](https://github.com/iptv-org/iptv):

- **Categories:** News, Sports, Movies, Entertainment, Music, Documentary
- **Countries:** India (`in`)
- **Regions:** Worldwide (`ww`)

The non-India country playlists (US/UK/AU/CA/…) are intentionally
omitted — every channel from them has a non-`.in` `tvg-id` and would be
filtered out anyway. Sources are merged and deduplicated by stream
URL. The default `PLAYLIST_SOURCES` list lives at the top of
`scripts/generate.js` and can be edited to add or remove sources.

### Filtering

The default filter keeps only channels that:

1. Have `"1080p"` in their `tvg-name` / display name (case-insensitive), **and**
2. Have a `tvg-id` ending in `.in` (India) — matched as `\.in($|\.|@)` so
   it correctly accepts IDs like `ChannelName.in@SD`, `ChannelName.in.`,
   or `ChannelName.in`.

### Regenerate locally

```bash
npm install
node scripts/generate.js                    # Full run with verification
node scripts/generate.js --no-verify        # Skip stream probing
node scripts/generate.js --no-verify-icons  # Skip logo probing (verification still runs)
```

### Verify channels actually work

The generator runs a HEAD probe on every stream URL and a HEAD probe on
every logo URL, both in parallel. Channels whose stream URL returns a
4xx/5xx (or times out) are dropped. Logos that return a clear 4xx/5xx
are dropped; network errors are treated as ambiguous and the logo is
kept.

Tunable via env:

| Env var | Default | Purpose |
| --- | --- | --- |
| `VERIFY_TIMEOUT_MS` | `6000` | Per-request timeout for stream/icon probes |
| `VERIFY_CONCURRENCY` | `8` | Max parallel probes |
| `BASE_URL` | `https://node-bug.github.io/ch/` | Used in the M3U's `url-tvg="…"` header so players can auto-discover the EPG |

> Note: `scripts/verify.js` does not currently exist. Verification is handled directly by `scripts/generate.js`.

## License

MIT