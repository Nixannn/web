// nixan-activity worker
// Polls Lanyard every 2 minutes and stores Discord activity history in KV.
// Exposes GET /activity returning the stored list.
//
// Required Cloudflare Worker bindings:
//   - env.KV         → KV namespace
//   - env.DISCORD_ID → string, your Discord user ID
// Required cron trigger:
//   - "*/2 * * * *"  (every 2 minutes)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const SESSION_GAP_MS = 30 * 60 * 1000;        // 30 min — same activity within this window = same session
const MAX_ITEMS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function assetImgUrl(applicationId, asset) {
  if (!asset) return null;
  // Discord media-proxy assets are prefixed with "mp:"
  if (asset.startsWith('mp:')) return `https://media.discordapp.net/${asset.slice(3)}`;
  if (applicationId) return `https://cdn.discordapp.com/app-assets/${applicationId}/${asset}.png`;
  return null;
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.DISCORD_ID || !env.KV) return;

    let data;
    try {
      const res = await fetch(`https://api.lanyard.rest/v1/users/${env.DISCORD_ID}`, {
        cf: { cacheTtl: 0 }
      });
      if (!res.ok) return;
      const json = await res.json();
      data = json.data;
    } catch (e) { return; }
    if (!data) return;

    const stored = JSON.parse((await env.KV.get('activity:list')) || '[]');
    const now = Date.now();

    // Build the set of current activities we care about: type 0 (playing) and 2 (listening, includes Spotify)
    const current = [];
    for (const a of (data.activities || [])) {
      if (a.type !== 0 && a.type !== 2) continue;
      const assets = a.assets || {};
      current.push({
        name: a.name,
        type: a.type,
        application_id: a.application_id || null,
        details: a.details || null,
        state: a.state || null,
        large_image: assets.large_image || null,
        large_image_url: assetImgUrl(a.application_id, assets.large_image)
      });
    }

    // For each current activity, update an existing recent entry or insert a new one
    for (const a of current) {
      const recent = stored.find(
        x => x.name === a.name && (now - x.last_seen) < SESSION_GAP_MS
      );
      if (recent) {
        recent.last_seen = now;
        if (a.details) recent.details = a.details;
        if (a.state) recent.state = a.state;
        if (a.large_image_url) recent.large_image_url = a.large_image_url;
      } else {
        stored.unshift({
          ...a,
          started_at: now,
          last_seen: now
        });
      }
    }

    // Sort newest-first by last_seen, prune by age + count
    stored.sort((a, b) => b.last_seen - a.last_seen);
    const cutoff = now - MAX_AGE_MS;
    const pruned = stored.filter(x => x.last_seen > cutoff).slice(0, MAX_ITEMS);

    await env.KV.put('activity:list', JSON.stringify(pruned));
  },

  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/activity') {
      const list = JSON.parse((await env.KV.get('activity:list')) || '[]');
      return new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    if (url.pathname === '/games') {
      const list = JSON.parse((await env.KV.get('activity:list')) || '[]');
      const seen = new Set();
      const games = [];
      for (const it of list) {
        if (it.type !== 0) continue;
        if (NON_GAMES.has(it.name)) continue;
        if (seen.has(it.name)) continue;
        seen.add(it.name);
        games.push(it);
        if (games.length >= 5) break;
      }
      const enriched = await Promise.all(games.map(async g => {
        const meta = g.application_id ? await getAppMetadata(g.application_id, env) : null;
        return {
          name: g.name,
          application_id: g.application_id,
          details: g.details,
          state: g.state,
          last_seen: g.last_seen,
          icon_url: g.large_image_url,
          description: (meta && (meta.description || meta.summary)) || null,
          cover_url: appIconUrl(g.application_id, meta && meta.cover_image),
          splash_url: appIconUrl(g.application_id, meta && meta.splash)
        };
      }));
      return new Response(JSON.stringify(enriched), {
        headers: { 'Content-Type': 'application/json', ...CORS }
      });
    }

    return new Response('not found', { status: 404, headers: CORS });
  }
};

const APP_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

// Apps that show up as Discord activity but aren't "games" — keep them out of /games
const NON_GAMES = new Set([
  'Visual Studio Code', 'Visual Studio', 'IntelliJ IDEA', 'WebStorm', 'PyCharm',
  'Rider', 'PhpStorm', 'GoLand', 'CLion', 'RubyMine', 'DataGrip',
  'Sublime Text', 'Atom', 'Android Studio', 'Xcode', 'Cursor', 'Zed', 'Neovim',
  'Notion', 'Figma', 'Slack', 'Microsoft Teams', 'Zoom', 'OBS Studio', 'Streamlabs'
]);

function appIconUrl(appId, hash) {
  if (!appId || !hash) return null;
  return `https://cdn.discordapp.com/app-icons/${appId}/${hash}.png?size=512`;
}

async function getAppMetadata(appId, env) {
  const key = `app:${appId}`;
  const cached = await env.KV.get(key);
  if (cached) return JSON.parse(cached);
  try {
    const r = await fetch(`https://discord.com/api/v10/applications/${appId}/rpc`);
    if (!r.ok) return null;
    const meta = await r.json();
    await env.KV.put(key, JSON.stringify(meta), { expirationTtl: APP_CACHE_TTL });
    return meta;
  } catch {
    return null;
  }
}
