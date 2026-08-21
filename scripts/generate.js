'use strict';

/**
 * Daily generator script.
 *
 * Fetches M3U playlists published by iptv-org
 * (https://github.com/iptv-org/iptv) and merges them into a single playlist,
 * then writes both the M3U and an EPG (XMLTV) file into the repository so
 * they can be committed by the CI job.
 *
 * Output files (written to the repo root):
 *   - channels.m3u
 *   - epg.xml
 */

const fs = require('fs');
const path = require('path');

const m3u = require('../index.js');
const { verifyChannels } = require('./verify.js');

// Expose pure helpers for testing. The module is also runnable directly.
module.exports = { parseExtinf, findTitleCommaIdx, escapeXml, buildEpg, buildPlaylistFromText, validateIconUrls, probeIcon, verifyChannels };

// ---------------------------------------------------------------------------
// iptv-org playlist sources
//
// These are the public, per-category/per-country playlists published by
// iptv-org at https://iptv-org.github.io/iptv/. They are merged (deduplicated
// by URL) into a single guide.
// ---------------------------------------------------------------------------
const IPTV_BASE = 'https://iptv-org.github.io/iptv';
const IPTV_RAW_BASE = 'https://raw.githubusercontent.com/iptv-org/iptv/master';
const PLAYLIST_SOURCES = [
  // News categories
  { group: 'News', url: `${IPTV_BASE}/categories/news.m3u` },
  { group: 'Sports', url: `${IPTV_BASE}/categories/sports.m3u` },
  { group: 'Movies', url: `${IPTV_BASE}/categories/movies.m3u` },
  { group: 'Entertainment', url: `${IPTV_BASE}/categories/entertainment.m3u` },
  { group: 'Music', url: `${IPTV_BASE}/categories/music.m3u` },
  { group: 'Documentary', url: `${IPTV_BASE}/categories/documentary.m3u` },
  
  // Country-specific sources (with enhanced India focus)
  { group: 'News (US)', url: `${IPTV_BASE}/countries/us.m3u` },
  { group: 'News (UK)', url: `${IPTV_BASE}/countries/uk.m3u` },
  { group: 'News (IN)', url: `${IPTV_BASE}/countries/in.m3u` },
  { group: 'News (AU)', url: `${IPTV_BASE}/countries/au.m3u` },
  { group: 'News (CA)', url: `${IPTV_BASE}/countries/ca.m3u` },
  
  // Regional sources
  { group: 'Worldwide', url: `${IPTV_BASE}/regions/ww.m3u` },
  
  // India-specific sources from raw content
  { group: 'India Streams', url: `${IPTV_RAW_BASE}/streams/in.m3u` },
  
  // Specialized sources
  { group: 'Samsung (IN)', url: `${IPTV_RAW_BASE}/streams/in_samsung.m3u` },
  
  // Sony Entertainment Television Asia HD (1080p) — sourced from iptvcat
  // (https://iptvcat.com/india__7/s/sony). This stream uses tvg-country="IN"
  // rather than a tvg-id, so it bypasses the default .in / 1080p filters.
  { group: 'Sony Asia (IN)', url: 'https://list.iptvcat.com/my_list/s/1e9b670b3031f1d7bf3b4114ef770576.m3u8', skipFilters: true },
];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'm3u-ci/daily-guide (+https://github.com/nodebug/m3u)' }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.text();
    } catch (err) {
      if (attempt === retries) {
        console.warn(`Warning: could not fetch ${url}: ${err.message}`);
        return '';
      }
      // small back-off before retry
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return '';
}

/**
 * Find the index of the comma that separates the EXTINF attribute block
 * from the title — i.e. the *first* comma that lives outside of a
 * double-quoted region.
 *
 * Upstream iptv-org playlists often have attribute values that contain
 * commas (notably `http-user-agent="Mozilla/5.0 (..., like Gecko)
 * Chrome/142.0.0.0 ..."`), so a naive `line.indexOf(',')` will land
 * inside an attribute value and chop the title to garbage.
 */
function findTitleCommaIdx(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse an EXTINF line into its attribute map.
 * e.g. #EXTINF:-1 tvg-id="X" tvg-logo="Y" group-title="Z",Title
 *
 * The title is everything after the first comma that lives outside of
 * any double-quoted attribute value, so we don't trip on values like
 * `http-user-agent="Mozilla/5.0 (..., like Gecko) Chrome/..."`.
 */
function parseExtinf(line) {
  const attrs = {};
  const commaIdx = findTitleCommaIdx(line);
  const name = (commaIdx >= 0 ? line.slice(commaIdx + 1) : '').trim();
  const attrPart = commaIdx >= 0 ? line.slice(0, commaIdx) : line;

  const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(attrPart)) !== null) {
    attrs[m[1]] = m[2];
  }
  return { attrs, name };
}

/**
 * Parse the body of an M3U playlist into normalized channel records.
 * Pure function (no I/O) so it can be unit-tested.
 *
 * @param {string} text - Raw playlist text
 * @param {Object} defaults - Default group name to apply
 * @returns {Object[]} Channel records
 */
function buildPlaylistFromText(text, defaults = {}) {
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      const { attrs, name } = parseExtinf(line);
      current = {
        id: attrs['tvg-id'] || '',
        name: name || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || defaults.group || 'Undefined',
        url: ''
      };
      continue;
    }

    if (line.startsWith('#EXT') || line.startsWith('#')) {
      // skip other tags (incl. #EXTVLCOPT options)
      continue;
    }

    if (current) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }

  return channels;
}

/**
 * Fetch one iptv-org playlist and return normalized channel records.
 */
async function fetchPlaylist(source) {
  const text = await fetchText(source.url);
  return buildPlaylistFromText(text, source);
}

// ---------------------------------------------------------------------------
// Build merged M3U playlist
// ---------------------------------------------------------------------------

async function buildPlaylist() {
  const all = [];
  const seenUrls = new Set();

  for (const source of PLAYLIST_SOURCES) {
    const channels = await fetchPlaylist(source);
    for (const ch of channels) {
      if (!ch.url) continue;
      if (seenUrls.has(ch.url)) continue; // dedupe by URL
      
      // Apply filters based on source type
      if (source.skipFilters) {
        // Sources flagged with skipFilters bypass the default 1080p / .in filters
      } else if (source.group === 'Samsung (IN)') {
        // For Samsung India source: include all channels (no filters)
      } else {
        // For all other sources: apply both filters
        // Only include channels that have "1080p" in the name (case-insensitive)
        if (!ch.name.toLowerCase().includes('1080p')) continue;
        // Only include channels from India (tvg-id contains ".in" as a country code)
        if (!ch.id || !ch.id.match(/(^|\.|@)in($|\.|@)/)) continue;
      }
      
      seenUrls.add(ch.url);
      all.push(ch);
    }
  }

  return all;
}

// ---------------------------------------------------------------------------
// EPG (XMLTV format)
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hoursLater(now, hour) {
  const d = new Date(now);
  d.setHours(d.getHours() + hour);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Probe a single icon URL with a HEAD request. Resolves to
 * { ok, status, reason }. 4xx/5xx responses are unambiguously bad;
 * network errors are treated as *ambiguous* (ok=false, but the caller
 * may decide to keep the logo in case the failure is just local DNS).
 */
function probeIcon(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, status: 0, reason: 'bad-url' });
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(
      {
        method: 'HEAD',
        host: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'm3u-ci/icon-check (+https://github.com/nodebug/m3u)' },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        res.resume();
        resolve({
          ok: status >= 200 && status < 400,
          status,
          reason: status >= 200 && status < 400 ? undefined : `HTTP ${status}`,
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, status: 0, reason: err.code || err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, reason: 'timeout' });
    });
    req.end();
  });
}

/**
 * Validate every logo URL we'll emit in the EPG.
 *
 * - Issues HEAD requests in parallel (capped by `concurrency`).
 * - Drops logos that return a clear 4xx/5xx (icon is definitively gone).
 * - KEEPS logos whose lookup failed for ambiguous reasons (DNS / timeout
 *   / TLS) so that CI doesn't lose icons just because the runner has a
 *   flaky network.
 *
 * Mutates `channels` in place (clears `logo` for dead ones) and returns
 * a summary { kept, dropped, ambiguous }.
 */
async function validateIconUrls(channels, { concurrency = 8, log = () => {} } = {}) {
  // Dedupe URLs but remember which channels share them.
  const urlToChannels = new Map();
  for (const ch of channels) {
    if (ch.logo) {
      if (!urlToChannels.has(ch.logo)) urlToChannels.set(ch.logo, []);
      urlToChannels.get(ch.logo).push(ch);
    }
  }

  const urls = [...urlToChannels.keys()];
  const results = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const i = cursor++;
      results[i] = { url: urls[i], probe: await probeIcon(urls[i]) };
    }
  }

  log(`Probing ${urls.length} unique logos (concurrency=${concurrency})... `);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker)
  );
  log('\n');

  let kept = 0, dropped = 0, ambiguous = 0;
  for (const r of results) {
    const { url, probe } = r;
    const owners = urlToChannels.get(url) || [];
    if (probe.ok) {
      kept += owners.length;
      continue;
    }
    // 4xx/5xx are definitive — drop. Network errors are ambiguous — keep.
    if (probe.status >= 400 && probe.status < 600) {
      for (const ch of owners) ch.logo = '';
      dropped += owners.length;
      log(`  [HTTP ${probe.status}] drop icon: ${url}`);
    } else {
      ambiguous += owners.length;
      log(`  [${probe.reason || 'net-err'}] keep icon: ${url}`);
    }
  }

  log(`Logos: kept=${kept} (${kept - ambiguous} verified, ${ambiguous} kept-due-to-ambiguity), dropped=${dropped}`);
  return { kept, dropped, ambiguous };
}

function buildEpg(channels, now) {
  const channelNodes = channels
    .map((ch) => `  <channel id="${escapeXml(ch.id || ch.name)}">
    <display-name lang="en">${escapeXml(ch.name)}</display-name>
    ${ch.logo ? `<icon src="${escapeXml(ch.logo)}" />` : ''}
  </channel>`)
    .join('\n');

  const programmeNodes = channels
    .map((ch) => {
      const start = hoursLater(now, 1);
      const stop = hoursLater(now, 3);
      return `  <programme channel="${escapeXml(ch.id || ch.name)}" start="${start}" stop="${stop}">
    <title lang="en">${escapeXml(ch.name)}</title>
    <desc lang="en">Auto-generated guide entry for ${escapeXml(ch.name)}.</desc>
    <category>Entertainment</category>
  </programme>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="m3u-ci" generator-info-url="https://github.com/nodebug/m3u">
${channelNodes}
${programmeNodes}
</tv>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const args = new Set(process.argv.slice(2));
  const shouldVerify = args.has('--verify');
  const shouldVerifyIcons = !args.has('--no-verify-icons');
  const dryRun = args.has('--dry-run');
  let channels = await buildPlaylist();
  console.log(`Fetched ${channels.length} unique channels from iptv-org`);

  if (shouldVerify) {
    const { alive, dead } = await verifyChannels(channels, {
      log: (s) => (typeof s === 'string' && s.includes('\n') ? process.stdout.write(s + '\n') : process.stdout.write(s)),
    });
    console.log(`Kept ${alive.length} working channels, dropped ${dead.length} dead ones.`);
    channels = alive;
  }

  if (shouldVerifyIcons) {
    await validateIconUrls(channels, {
      log: (s) => process.stdout.write(s + '\n'),
    });
  } else {
    console.log('--no-verify-icons: skipping icon URL checks');
  }

  if (dryRun) {
    console.log(`\n--dry-run: would write ${channels.length} channels to channels.m3u + epg.xml`);
    for (const ch of channels.slice(0, 10)) console.log(`  ${ch.name}  ${ch.url}`);
    if (channels.length > 10) console.log(`  ...and ${channels.length - 10} more`);
    return;
  }

  // --- M3U ---
  // `urlTvg` becomes a `url-tvg="..."` attribute on the #EXTM3U header.
  // IPTV players fetch that XMLTV file on their own, so we don't need to
  // download or inline the EPG here.
  const playlist = {
    title: `Generated TV Guide (${stamp})`,
    urlTvg: 'https://raw.githubusercontent.com/node-bug/ch/refs/heads/master/epg.xml',
    tracks: channels.map((ch) => ({
      title: ch.name,
      path: ch.url,
      duration: -1,
      tvgId: ch.id,
      tvgName: ch.name,
      tvgGroup: ch.group,
    })),
  };

  const m3uPath = path.join(__dirname, '..', 'channels.m3u');
  m3u.generate(m3uPath, playlist);

  // --- EPG ---
  const epgXml = buildEpg(channels, now);
  const epgPath = path.join(__dirname, '..', 'epg.xml');
  fs.writeFileSync(epgPath, epgXml, 'utf-8');

  console.log(`Generated ${m3uPath}`);
  console.log(`Generated ${epgPath}`);
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});