// green-dew worker — extended with private location + referrer tracking.
// Drop-in replacement for your existing worker code.
//
// Required bindings:
//   - env.VIEWS     → KV namespace (existing)
//   - env.COMMENTS  → KV namespace (existing)
//   - env.SALT      → Secret (NEW — any random string, prevents reversing IP hashes)
//   - env.STATS_KEY → Secret (NEW — your private password to view stats)
//
// Public:
//   GET  /views        → { count }
//   GET  /comments     → comment list
//   POST /comments     → add comment
//
// Private (requires ?key=YOUR_STATS_KEY):
//   GET  /stats        → { count, recent[], byCountry, byReferrer }
//
// Privacy: raw IPs are NEVER stored. Each visitor is hashed (SHA-256 + salt),
// truncated to 8 bytes, used only for dedupe inside a 5-min window.

const ORIGIN = 'https://nixan.lol';
const corsHeaders = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const RECENT_CAP = 50;

function parseReferrer(ref) {
  if (!ref) return 'direct';
  try {
    const u = new URL(ref);
    const h = u.hostname.replace(/^www\./, '');
    if (h === 'nixan.lol') return 'direct';
    if (h.includes('discord')) return 'discord';
    if (h === 'x.com' || h.includes('twitter') || h === 't.co') return 'twitter';
    if (h.includes('reddit')) return 'reddit';
    if (h.includes('google')) return 'google';
    if (h.includes('youtube') || h === 'youtu.be') return 'youtube';
    if (h.includes('instagram')) return 'instagram';
    if (h.includes('tiktok')) return 'tiktok';
    if (h.includes('telegram') || h === 't.me') return 'telegram';
    return h;
  } catch { return 'direct'; }
}

async function hashIp(ip, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + salt));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleViews(request, env) {
  const cf = request.cf || {};
  const country = (cf.country || '??').toUpperCase();
  const city = cf.city || null;
  const region = cf.region || null;
  const referer = request.headers.get('Referer') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';

  const ipHash = ip ? await hashIp(ip, env.SALT || 'unsalted') : 'none';

  const [countRaw, recentRaw, byCountryRaw, byRefRaw] = await Promise.all([
    env.VIEWS.get('count'),
    env.VIEWS.get('recent'),
    env.VIEWS.get('byCountry'),
    env.VIEWS.get('byReferrer')
  ]);
  let count = parseInt(countRaw || '0');
  const recent = JSON.parse(recentRaw || '[]');
  const byCountry = JSON.parse(byCountryRaw || '{}');
  const byReferrer = JSON.parse(byRefRaw || '{}');

  const dupe = recent.find(v => v.ipHash === ipHash && (Date.now() - v.ts) < DEDUPE_WINDOW_MS);

  if (!dupe) {
    count += 1;
    const ref = parseReferrer(referer);
    recent.unshift({ country, city, region, ref, ts: Date.now(), ipHash });

    byCountry[country] = (byCountry[country] || 0) + 1;
    byReferrer[ref] = (byReferrer[ref] || 0) + 1;

    await Promise.all([
      env.VIEWS.put('count', String(count)),
      env.VIEWS.put('recent', JSON.stringify(recent.slice(0, RECENT_CAP))),
      env.VIEWS.put('byCountry', JSON.stringify(byCountry)),
      env.VIEWS.put('byReferrer', JSON.stringify(byReferrer))
    ]);
  }

  // Public response: only the total count. Stats stay private.
  return new Response(JSON.stringify({ count }), { headers: corsHeaders });
}

async function handleStats(request, env) {
  const url = new URL(request.url);
  const provided = url.searchParams.get('key') || request.headers.get('X-Stats-Key') || '';
  if (!env.STATS_KEY || provided !== env.STATS_KEY) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: corsHeaders
    });
  }

  const [countRaw, recentRaw, byCountryRaw, byRefRaw] = await Promise.all([
    env.VIEWS.get('count'),
    env.VIEWS.get('recent'),
    env.VIEWS.get('byCountry'),
    env.VIEWS.get('byReferrer')
  ]);

  const recent = JSON.parse(recentRaw || '[]').map(({ ipHash, ...r }) => r);

  return new Response(JSON.stringify({
    count: parseInt(countRaw || '0'),
    recent,
    byCountry: JSON.parse(byCountryRaw || '{}'),
    byReferrer: JSON.parse(byRefRaw || '{}')
  }, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (url.pathname === '/views') return handleViews(request, env);

    if (url.pathname === '/stats' && request.method === 'GET') return handleStats(request, env);

    if (url.pathname === '/comments' && request.method === 'GET') {
      const data = await env.COMMENTS.get('all');
      return new Response(data || '[]', { headers: corsHeaders });
    }

    if (url.pathname === '/comments' && request.method === 'POST') {
      const body = await request.json();
      const name = (body.name || 'anonymous').slice(0, 32);
      const message = (body.message || '').slice(0, 280);
      if (!message) return new Response(JSON.stringify({ error: 'empty' }), { status: 400, headers: corsHeaders });

      const existing = JSON.parse((await env.COMMENTS.get('all')) || '[]');
      existing.unshift({ name, message, timestamp: Date.now() });
      await env.COMMENTS.put('all', JSON.stringify(existing.slice(0, 100)));
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  }
};
