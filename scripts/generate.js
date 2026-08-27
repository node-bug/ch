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

// `data/dead-icons.json` holds the list of icon URLs we've previously
// determined to be definitively broken (HTTP 4xx/5xx). On subsequent
// runs we skip probing them — they're already cleared from `channels`
// before they reach the EPG writer — and skip the wasted network round
// trip. A user (or a workflow) can prune entries from this file if a
// CDN recovers.
const DEAD_ICONS_PATH = path.join(__dirname, '..', 'data', 'dead-icons.json');
function loadDeadIcons() {
  try {
    const raw = fs.readFileSync(DEAD_ICONS_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}
function saveDeadIcons(set) {
  try {
    fs.mkdirSync(path.dirname(DEAD_ICONS_PATH), { recursive: true });
    fs.writeFileSync(
      DEAD_ICONS_PATH,
      JSON.stringify([...set].sort(), null, 2) + '\n',
      'utf-8'
    );
  } catch (err) {
    console.warn(`Warning: could not write ${DEAD_ICONS_PATH}: ${err.message}`);
  }
}

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
];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'm3u-ci/daily-guide (+https://github.com/node-bug/m3u)' }
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
  d.setMinutes(d.getMinutes() + hour * 60);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Format a Date as an XMLTV timestamp (YYYY-MM-DDTHH:MM:SSZ).
 */
function xmltvTs(d) {
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
        headers: { 'User-Agent': 'm3u-ci/icon-check (+https://github.com/node-bug/m3u)' },
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
  // Pre-seed from the persistent dead-icons denylist so we don't re-probe
  // icons we already know are broken. They get cleared from `channels`
  // up-front to keep the EPG clean.
  const deadIconCache = loadDeadIcons();
  let preCleared = 0;
  for (const ch of channels) {
    if (ch.logo && deadIconCache.has(ch.logo)) {
      ch.logo = '';
      preCleared++;
    }
  }
  if (preCleared) log(`Skipped ${preCleared} icons from dead-icons cache.\n`);

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
      deadIconCache.add(url);
      log(`  [HTTP ${probe.status}] drop icon: ${url}`);
    } else {
      ambiguous += owners.length;
      log(`  [${probe.reason || 'net-err'}] keep icon: ${url}`);
    }
  }

  saveDeadIcons(deadIconCache);

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

  // Emit programme slots covering both directions in time so the EPG
  // is useful even if the user opens the playlist hours after the
  // last CI run.
  //
  //  - `pastSlots` of 2h slots back-fill the previous 12 hours, so the
  //    "current" programme is always the one that began at the most
  //    recent half-hour mark (IPTV players key the on-screen guide off
  //    the programme that contains "now").
  //  - `futureSlots` of 2h slots extend 12 hours into the future, so
  //    the guide covers a useful "now → tonight" range.
  //
  // We then *drop* any slot whose [start, stop) window lies entirely
  // in the past — a stale EPG entry is worse than a missing one for
  // IPTV players.
  const slotMs = 2 * 60 * 60 * 1000;
  const pastSlots = 6;   // 12h of back-fill (2h × 6)
  const futureSlots = 6; // 12h of forward coverage (2h × 6)
  const anchor = new Date(now.getTime());
  anchor.setMinutes(anchor.getMinutes() - (anchor.getMinutes() % 30), 0, 0);
  const anchorMs = anchor.getTime();
  const totalSlots = pastSlots + futureSlots;
  const baseStart = anchorMs - pastSlots * slotMs;

  const programmeNodes = channels
    .map((ch) => {
      const slots = [];
      for (let i = 0; i < totalSlots; i++) {
        const startMs = baseStart + i * slotMs;
        const stopMs = startMs + slotMs;
        // Skip slots that have already ended — a stale EPG entry is
        // worse than a missing one for IPTV players.
        if (stopMs <= now.getTime()) continue;
        const start = xmltvTs(new Date(startMs));
        const stop = xmltvTs(new Date(stopMs));
        slots.push(`  <programme channel="${escapeXml(ch.id || ch.name)}" start="${start}" stop="${stop}">
    <title lang="en">${escapeXml(ch.name)}</title>
    <desc lang="en">Auto-generated guide entry for ${escapeXml(ch.name)}.</desc>
    <category>Entertainment</category>
  </programme>`);
      }
      return slots.join('\n');
    })
    .filter(Boolean)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="m3u-ci" generator-info-url="https://github.com/node-bug/m3u">
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
  const shouldVerify = !args.has('--no-verify');
  const shouldVerifyIcons = true;
  let channels = await buildPlaylist();
  console.log(`Fetched ${channels.length} unique channels from iptv-org`);

  if (shouldVerify) {
    const { alive, dead } = await verifyChannels(channels, {
      log: (s) => (typeof s === 'string' && s.includes('\n') ? process.stdout.write(s + '\n') : process.stdout.write(s)),
    });
    console.log(`Kept ${alive.length} working channels, dropped ${dead.length} dead ones.`);
    channels = alive;
  }

  await validateIconUrls(channels, {
      log: (s) => process.stdout.write(s + '\n'),
    });

  // --- M3U ---
  // `urlTvg` becomes a `url-tvg="..."` attribute on the #EXTM3U header.
  // IPTV players fetch that XMLTV file on their own, so we don't need to
  // download or inline the EPG here.
  //
  // BASE_URL lets the workflow point the header at GitHub Pages instead
  // of the raw master branch. It defaults to the current repo's Pages
  // URL so local runs (where the env var isn't set) still produce a
  // valid `url-tvg`.
  const baseUrl = process.env.BASE_URL || 'https://node-bug.github.io/ch/';

  const playlist = {
    title: `Generated TV Guide (${stamp})`,
    urlTvg: `${baseUrl}epg.xml`,
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

if (require.main === module) {
  main().catch((err) => {
    console.error('Generation failed:', err);
    process.exit(1);
  });
}