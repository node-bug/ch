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

A GitHub Actions workflow (`.github/workflows/daily-guide.yml`) runs every day at
4:00 AM IST and generates:

- `channels.m3u` — a merged M3U playlist sourced from
  [iptv-org](https://github.com/iptv-org/iptv) (categories, countries, regions),
  filtered to include only channels with "1080p" in their name.
  - For most sources (News, Sports, etc.): additionally filtered to India-only channels (`.in` tvg-id)
  - For Samsung India source: all 1080p channels are included (no India filter)
- `epg.xml` — a matching EPG (XMLTV) file for the same channels.

The generated files are committed back into the repository automatically.

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

## License

MIT