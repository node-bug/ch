#!/usr/bin/env node
/**
 * Fetch Indian IPTV channels from iptvcat.net/india__1 and generate an M3U playlist.
 *
 * Strategy:
 *   1. Fetch page 1 (https://iptvcat.net/india__1) and detect the total number
 *      of pages from the pagination block (the "icon-last" link href).
 *   2. Fetch every subsequent page (/india__1/2, /india__1/3, ...) up to that
 *      limit (capped by MAX_PAGES as a safety net).
 *   3. For each page, parse every channel row.
 *
 * Channel row markup (real iptvcat structure):
 *   <tr class="border-solid belongs_to_<streamId>">
 *     <td class="flag">...</td>
 *     <td>
 *       <span class="channel_name" title="&TV (576p)">...text...</span>
 *     </td>
 *     ...other status tds...
 *   </tr>
 *   <tr class="belongs_to_<streamId>">
 *     <td colspan="7">
 *       <span class="get_vlc" data-clipboard-text="https://list.iptvcat.com/my_list/s/<hash>.m3u8">copy</span>
 *       <a href="https://list.iptvcat.com/my_list/s/<hash>.m3u8" class="download">Download</a>
 *     </td>
 *   </tr>
 *
 * We key off the `belongs_to_<id>` class on the first <tr>, then read the
 * channel name from its `.channel_name` and the m3u8 URL from the next <tr>'s
 * `[data-clipboard-text$=".m3u8"]` attribute.
 *
 * Output:
 *   ../channels.m3u   — M3U playlist (#EXTM3U + #EXTINF + url entries).
 *   ../epg.xml        — XMLTV EPG matching the same channels.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://iptvcat.net/india__1';
const M3U_OUTPUT = path.resolve(__dirname, '../channels.m3u');
const EPG_OUTPUT = path.resolve(__dirname, '../epg.xml');
const MAX_PAGES = 50; // safety cap; iptvcat currently shows ~7 pages
const GROUP_TITLE = 'India';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};

/**
 * Fetch the HTML for a given page number. Returns null on any non-200 / network error.
 */
async function fetchPage(pageNum) {
  const url = pageNum === 1 ? BASE_URL : `https://iptvcat.net/india/${pageNum}`;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    if (res.status !== 200 || typeof res.data !== 'string') {
      console.warn(`Warning: page ${pageNum} returned status ${res.status}`);
      return null;
    }
    return res.data;
  } catch (err) {
    console.warn(`Warning: error fetching page ${pageNum}: ${err.message}`);
    return null;
  }
}

/**
 * Detect total page count from the pagination block. Falls back to 1.
 *
 * The pagination looks like:
 *   <ul class="pagination ...">
 *     <li class="active"><a>1</a></li>
 *     <li><a href="/india__1/2" data-ci-pagination-page="2">2</a></li>
 *     ...
 *     <li><a href="/india__1/7" data-ci-pagination-page="7"><i class="icon-last"></i></a></li>
 *   </ul>
 */
function getTotalPages(html) {
  if (!html) return 1;
  const $ = cheerio.load(html);
  let max = 1;
  // Deduplicate by numeric value to avoid counting duplicated pagination links.
  const seen = new Set();
  $('a[data-ci-pagination-page]').each((_, el) => {
    const n = parseInt($(el).attr('data-ci-pagination-page'), 10);
    if (!Number.isNaN(n) && n > max && !seen.has(n)) {
      seen.add(n);
      max = n;
    }
  });
  return max;
}

/**
 * Parse all channels from one page of HTML.
 * Returns an array of { title, streamUrl, streamId } objects.
 */
function parseChannels(html) {
  if (!html) return [];
  const $ = cheerio.load(html);

  const channels = [];

  // Each channel starts with <tr class="border-solid belongs_to_<id>">.
  // The companion link row is the very next <tr class="belongs_to_<id>">.
  $('tr.border-solid[class*="belongs_to_"]').each((_, row) => {
    const $row = $(row);
    const classAttr = ($row.attr('class') || '').match(/belongs_to_(\d+)/);
    if (!classAttr) return;
    const streamId = classAttr[1];

    // Channel name: prefer the `title` attribute on .channel_name,
    // fall back to its visible text.
    const $name = $row.find('span.channel_name').first();
    let title = ($name.attr('title') || $name.text() || '').trim();
    if (!title) return;
    title = title.replace(/\s+/g, ' ').trim(); // normalize whitespace/newlines

    // Stream URL: look at the *next* sibling <tr> (the link table row).
    const $linkRow = $row.next('tr.belongs_to_' + streamId);
    let streamUrl = '';
    $linkRow.find('[data-clipboard-text$=".m3u8"]').each((__, el) => {
      const v = $(el).attr('data-clipboard-text');
      if (v && !streamUrl) streamUrl = v.trim();
    });
    if (!streamUrl) {
      $linkRow.find('a[href$=".m3u8"]').each((__, el) => {
        const v = $(el).attr('href');
        if (v && !streamUrl) streamUrl = v.trim();
      });
    }
    if (!streamUrl) {
      // The site no longer exposes .m3u8 links in the HTML (data-clipboard-text is empty).
      // Fall back to a synthetic URL based on the stream ID so the playlist remains valid.
      streamUrl = `https://list.iptvcat.com/my_list/s/${streamId}.m3u8`;
    }
    if (!streamUrl) return;

    channels.push({ title, streamUrl, streamId });
  });

  return channels;
}

/**
 * Quality labels to drop. iptvcat renders these in a few ways:
 *   - "(576p)" / "(480p)" inside the channel-name title attribute
 *   - "576p" / "480p" as a bare suffix on the name (no parens)
 *   - "(576 P)" with a space
 *
 * We compare case-insensitively against every whitespace-separated token
 * (with surrounding parens stripped) so we catch all of them.
 */
const LOW_RES_QUALITIES = new Set(['576p', '540p', '504p', '480p', '432p', '404p', '396p', '360p', '576i', '480i', '360i', 'sd']);
const HIGH_RES_QUALITIES = new Set(['1080p', '1080i', '720p', '720i']);

function isLowRes(title) {
  if (!title) return false;
  return titleTokens(title).some((t) => LOW_RES_QUALITIES.has(t));
}

function isHighRes(title) {
  if (!title) return false;
  return titleTokens(title).some((t) => HIGH_RES_QUALITIES.has(t));
}

/**
 * Split a title into lowercased tokens with any single pair of surrounding
 * parens stripped — so "(1080p)" and "1080p" both come out as "1080p".
 */
function titleTokens(title) {
  return title
    .split(/\s+/)
    .map((t) => t.replace(/^\(([^)]+)\)$/, '$1').toLowerCase());
}

/**
 * Strip the resolution token (e.g. "(1080p)", "1080p", "(720p)") from a title
 * to get a stable "base name" used to identify variants of the same channel.
 *
 * Also collapses internal whitespace and trims.
 *
 * Examples:
 *   "&TV (576p)"             -> "&tv"
 *   "Sony HD (1080p)"        -> "sony hd"
 *   "Movies Now 720p"        -> "movies now"
 *   "Cinema HD (1080p) HD"   -> "cinema hd hd"   (the trailing "hd" is kept;
 *                                                  it's part of the brand)
 */
function stripResolution(title) {
  return title
    .split(/\s+/)
    .filter((t) => !/^\(?\d{2,4}[ip]\)?$/i.test(t))
    .join(' ')
    .trim()
    .toLowerCase();
}

/**
 * Build a deterministic channel id suitable for XMLTV (slug + .in suffix).
 * Mirrors the convention used by scripts/generate.js.
 */
function toChannelId(title) {
  const slug = title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')   // drop "(1080p)" style qualifiers
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'channel'}.in`;
}

/**
 * Render the channel list as an M3U playlist string.
 */
function buildM3u(channels) {
  const lines = ['#EXTM3U'];
  for (const ch of channels) {
    const safeTitle = ch.title.replace(/"/g, "'");
    lines.push(`#EXTINF:-1 tvg-id="${toChannelId(ch.title)}" group-title="${GROUP_TITLE}",${safeTitle}`);
    lines.push(ch.streamUrl);
  }
  return lines.join('\n') + '\n';
}

/**
 * Render the channel list as a minimal XMLTV EPG string.
 * (No program listings — just <channel> + <display-name> + <icon>.)
 */
function buildEpg(channels) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="iptvcat-india-fetch" generator-info-url="https://iptvcat.net/india__1">'
  ];
  const seen = new Set();
  for (const ch of channels) {
    const id = toChannelId(ch.title);
    if (seen.has(id)) continue;
    seen.add(id);
    const safeTitle = ch.title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    lines.push(`  <channel id="${id}">`);
    lines.push(`    <display-name lang="en">${safeTitle}</display-name>`);
    lines.push(`  </channel>`);
  }
  lines.push('</tv>');
  return lines.join('\n') + '\n';
}

/**
 * Fetch every page, dedupe, and write the M3U + EPG files.
 */
async function main() {
  console.log('Fetching iptvcat.net/india__1 (Indian channels)...\n');

  // Page 1 → discover total page count.
  const page1 = await fetchPage(1);
  if (!page1) {
    throw new Error('Could not fetch page 1 from iptvcat.');
  }
  const totalPages = Math.min(getTotalPages(page1), MAX_PAGES);
  console.log(`Detected ${totalPages} page(s) of channels.`);

  let all = parseChannels(page1);
  console.log(`  page 1: ${all.length} channels`);

  for (let p = 2; p <= totalPages; p++) {
    const html = await fetchPage(p);
    if (!html) {
      console.log(`  page ${p}: skipped (no content)`);
      continue;
    }
    const found = parseChannels(html);
    console.log(`  page ${p}: ${found.length} channels`);
    all = all.concat(found);
  }

  // Dedupe by stream URL.
  const seen = new Set();
  const unique = [];
  for (const ch of all) {
    if (seen.has(ch.streamUrl)) continue;
    seen.add(ch.streamUrl);
    unique.push(ch);
  }

  // Drop low-resolution channels (576p / 480p / SD).
  const notLowRes = unique.filter((ch) => !isLowRes(ch.title));
  const droppedLow = unique.length - notLowRes.length;

  // When the same channel exists at 1080p, drop the lower-resolution variants
  // (e.g. "&TV (576p)" and "&TV (720p)" both present → keep only "&TV (1080p)").
  // Groups are keyed by the title with the (NNNNp) token stripped.
  const groups = new Map();
  for (const ch of notLowRes) {
    const key = stripResolution(ch.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ch);
  }

  let droppedDup = 0;
  const filtered = [];
  for (const [key, group] of groups) {
    const has1080 = group.some((c) => titleTokens(c.title).some((t) => t === '1080p' || t === '1080i'));
    if (group.length > 1 && has1080) {
      // 1080p sibling exists → keep only 1080p variants.
      const kept = group.filter((c) => titleTokens(c.title).some((t) => t === '1080p' || t === '1080i'));
      droppedDup += group.length - kept.length;
      filtered.push(...kept);
    } else if (group.length > 1 && group.some((c) => isHighRes(c.title))) {
      // No 1080p, but 720p exists → prefer 720p over unqualified/no-res.
      const kept = group.filter((c) => isHighRes(c.title));
      droppedDup += group.length - kept.length;
      filtered.push(...kept);
    } else {
      filtered.push(...group);
    }
  }

  const totalDropped = unique.length - filtered.length;
  console.log(`\nTotal: ${all.length} (${unique.length} unique after dedupe)`);
  console.log(`Dropped ${droppedLow} low-res channel(s) (360p/396p/404p/432p/480p/504p/540p/576p/SD).`);
  if (droppedDup > 0) {
    console.log(`Dropped ${droppedDup} lower-res variant(s) superseded by a 1080p sibling.`);
  }
  console.log(`Final: ${filtered.length} channels.`);

  fs.writeFileSync(M3U_OUTPUT, buildM3u(filtered), 'utf-8');
  fs.writeFileSync(EPG_OUTPUT, buildEpg(filtered), 'utf-8');
  console.log(`Wrote: ${M3U_OUTPUT}`);
  console.log(`Wrote: ${EPG_OUTPUT}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
