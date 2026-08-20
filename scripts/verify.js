'use strict';

/**
 * Stream health verifier.
 *
 * Probes each URL in a normalized channel list and drops the ones that
 * don't look like live streams. Used by `scripts/generate.js` when called
 * with the `--verify` flag (and runnable on its own for ad-hoc checks).
 *
 * Strategy:
 *   1. Issue a HEAD request (with a short timeout) to see if the host
 *      responds at all.
 *   2. If HEAD is rejected (405/501) or unavailable, fall back to a small
 *      ranged GET and inspect the first few bytes for media signatures
 *      (HLS "#EXTM3U", MPEG-TS sync byte 0x47, or any 2xx response body).
 *   3. Mark the channel alive only when we get a positive signal.
 *
 * Reachable ≠ working in general, but for IPTV links that die within hours
 * this filters out the worst offenders (404, connection refused, TLS errors)
 * before they end up in channels.m3u.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const HEAD_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 6000);
const MAX_PARALLEL = Number(process.env.VERIFY_CONCURRENCY || 8);
const USER_AGENT = 'm3u-ci/verify (+https://github.com/nodebug/m3u)';

/**
 * Probe a single URL. Resolves to { ok, status, reason, contentType }.
 */
function probe(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ ok: false, reason: 'bad-url' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return resolve({ ok: false, reason: 'unsupported-protocol' });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'HEAD',
        host: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': USER_AGENT },
        timeout: HEAD_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        // Some CDNs respond 405 to HEAD — fall back to a ranged GET.
        if (status === 405 || status === 501) {
          res.resume();
          return rangedProbe(parsed).then(resolve);
        }
        res.resume();
        resolve({
          ok: status >= 200 && status < 400,
          status,
          contentType: res.headers['content-type'] || '',
        });
      }
    );
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.end();
  });
}

/**
 * Ranged-GET fallback. Asks for the first ~512 bytes and looks for media
 * signatures. We deliberately *do not* treat "200 with empty body" as alive.
 */
function rangedProbe(parsed) {
  return new Promise((resolve) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        host: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': USER_AGENT,
          Range: 'bytes=0-1023',
        },
        timeout: HEAD_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        const chunks = [];
        let total = 0;
        const LIMIT = 2048;
        res.on('data', (buf) => {
          if (total < LIMIT) {
            chunks.push(buf);
            total += buf.length;
          } else {
            res.destroy();
          }
        });
        res.on('end', () => {
          const body = Buffer.concat(chunks).slice(0, LIMIT).toString('utf8');
          const looksHls = body.trimStart().startsWith('#EXTM3U');
          // MPEG-TS sync byte at offset 0 (or 188, 376, ...)
          const looksTs = total > 0 && (body.charCodeAt(0) === 0x47 || /[\u0000-\u0008]G/.test(body.slice(0, 4)));
          const ok =
            (status >= 200 && status < 400) && (looksHls || looksTs || total > 0);
          resolve({
            ok,
            status,
            reason: ok ? undefined : 'no-media-signature',
            contentType: res.headers['content-type'] || '',
          });
        });
        res.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
      }
    );
    req.on('error', (err) => resolve({ ok: false, reason: err.code || err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.end();
  });
}

/**
 * Run a worker-pool of `probe()` calls so we don't hammer upstream servers
 * with thousands of concurrent connections.
 */
async function verifyChannels(channels, opts = {}) {
  const concurrency = opts.concurrency || MAX_PARALLEL;
  const log = opts.log || (() => {});
  const results = new Array(channels.length);
  let cursor = 0;

  async function worker() {
    while (cursor < channels.length) {
      const i = cursor++;
      const ch = channels[i];
      const r = await probe(ch.url);
      results[i] = { channel: ch, probe: r };
      log(r.ok ? '.' : 'x');
    }
  }

  log(`Probing ${channels.length} channels (concurrency=${concurrency})... `);
  await Promise.all(Array.from({ length: Math.min(concurrency, channels.length) }, worker));
  log('\n');

  const alive = results.filter((r) => r.probe.ok).map((r) => r.channel);
  const dead = results.filter((r) => !r.probe.ok);

  log(`Alive: ${alive.length} / ${channels.length}`);
  log(`Dead:  ${dead.length}`);
  if (dead.length) {
    log('Dead channels:');
    for (const d of dead.slice(0, 50)) {
      const why = d.probe.status ? `HTTP ${d.probe.status}` : d.probe.reason;
      log(`  [${why}] ${d.channel.name}  ${d.channel.url}`);
    }
    if (dead.length > 50) log(`  ...and ${dead.length - 50} more`);
  }

  return { alive, dead, results };
}

module.exports = { probe, verifyChannels };

// Allow `node scripts/verify.js channels.m3u` for ad-hoc checks.
if (require.main === module) {
  const m3u = require('../index.js');
  const target = process.argv[2] || 'channels.m3u';
  const playlist = m3u.parse(target);
  const channels = (playlist.tracks || []).map((t) => ({
    name: t.title || t.path,
    url: t.path,
    id: t.tvgId || '',
  }));
  verifyChannels(channels, { log: (s) => process.stdout.write(s) }).then(
    ({ alive, dead }) => {
      console.log(`\nKept ${alive.length}, dropped ${dead.length}.`);
      process.exit(0);
    },
    (err) => {
      console.error('verify failed:', err);
      process.exit(1);
    }
  );
}
