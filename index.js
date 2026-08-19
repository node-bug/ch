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
  const lines = ['#EXTM3U'];

  if (playlist.title) {
    lines.push(`#PLAYLIST:${playlist.title}`);
  }

  for (const track of playlist.tracks || []) {
    if (track.duration !== undefined) {
      lines.push(`#EXTINF:${track.duration},${track.title || ''}`);
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