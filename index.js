'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse an M3U playlist file.
 *
 * @param {string} filePath - Path to the .m3u file
 * @returns {Object} Parsed playlist object
 */
function parse(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  const playlist = {
    title: null,
    tracks: []
  };

  let currentTrack = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('#EXTM3U')) {
      // Header line, nothing to parse
      continue;
    }

    if (line.startsWith('#PLAYLIST:')) {
      // Playlist title: #PLAYLIST:<title>
      playlist.title = line.slice('#PLAYLIST:'.length).trim();
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      // Extended info line: #EXTINF:<duration>,<title>
      const match = line.match(/^#EXTINF:(-?\d+),(.*)$/);
      if (match) {
        currentTrack = {
          duration: parseInt(match[1], 10),
          title: match[2].trim()
        };
      }
      continue;
    }

    if (line.startsWith('#EXT')) {
      // Other extended tags - skip for now
      continue;
    }

    if (line.startsWith('#')) {
      // Comment line
      continue;
    }

    if (line.length === 0) {
      continue;
    }

    // Path/URL line
    if (currentTrack) {
      currentTrack.path = line;
      playlist.tracks.push(currentTrack);
      currentTrack = null;
    } else {
      playlist.tracks.push({ path: line });
    }
  }

  return playlist;
}

/**
 * Generate an M3U playlist file.
 *
 * @param {string} filePath - Path to write the .m3u file
 * @param {Object} playlist - Playlist object
 * @returns {void}
 */
function generate(filePath, playlist) {
  // #EXTM3U supports a few header attributes. The most useful for IPTV
  // players is `url-tvg`, which points at a remote XMLTV file the player
  // fetches on its own — so we don't need to bundle the EPG in the M3U.
  const extm3uAttrs = [];
  if (playlist.urlTvg) {
    extm3uAttrs.push(`url-tvg="${playlist.urlTvg}"`);
  }
  const header = extm3uAttrs.length
    ? `#EXTM3U ${extm3uAttrs.join(' ')}`
    : '#EXTM3U';
  const lines = [header];

  if (playlist.title) {
    lines.push(`#PLAYLIST:${playlist.title}`);
  }

  for (const track of playlist.tracks || []) {
    if (track.duration !== undefined) {
      const attrs = [];
      if (track.tvgId) attrs.push(`tvg-id="${track.tvgId}"`);
      if (track.tvgName) attrs.push(`tvg-name="${track.tvgName}"`);
      if (track.tvgGroup) attrs.push(`group-title="${track.tvgGroup}"`);
      if (track.tvgLogo) attrs.push(`tvg-logo="${track.tvgLogo}"`);
      const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
      lines.push(`#EXTINF:${track.duration}${attrStr},${track.title || ''}`);
    }
    lines.push(track.path || '');
  }

  const content = lines.join('\n') + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

module.exports = {
  parse,
  generate
};