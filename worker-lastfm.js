// nixan-lastfm worker — Last.fm recently-played proxy
//
// Required bindings:
//   - env.LASTFM_API_KEY → Plaintext (free from https://www.last.fm/api/account/create)
//   - env.LASTFM_USER    → Plaintext (your last.fm username)
//
// Exposes GET /recent → array of last 5 tracks, formatted for the site.
// Cached at the Cloudflare edge for 60s so we don't hammer last.fm.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

const PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f'; // last.fm's "no image" placeholder

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    if (url.pathname !== '/recent') {
      return new Response('not found', { status: 404, headers: CORS });
    }

    if (!env.LASTFM_API_KEY || !env.LASTFM_USER) {
      return new Response(JSON.stringify({ error: 'not configured' }), {
        status: 500, headers: CORS
      });
    }

    const lf = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks` +
      `&user=${encodeURIComponent(env.LASTFM_USER)}` +
      `&api_key=${encodeURIComponent(env.LASTFM_API_KEY)}` +
      `&format=json&limit=6`;

    let res;
    try {
      res = await fetch(lf, { cf: { cacheTtl: 60, cacheEverything: true } });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'fetch failed' }), { status: 502, headers: CORS });
    }
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'lastfm error', status: res.status }), {
        status: 502, headers: CORS
      });
    }

    const data = await res.json();
    const raw = data?.recenttracks?.track || [];

    const tracks = raw.slice(0, 5).map(t => {
      const imgs = t.image || [];
      const pickImg = imgs.find(i => i.size === 'extralarge')?.['#text']
        || imgs.find(i => i.size === 'large')?.['#text']
        || null;
      const album_art = pickImg && !pickImg.includes(PLACEHOLDER_HASH) ? pickImg : null;

      return {
        name: t.name,
        artist: typeof t.artist === 'string' ? t.artist : (t.artist?.['#text'] || ''),
        album: typeof t.album === 'string' ? t.album : (t.album?.['#text'] || ''),
        album_art,
        url: t.url,
        played_at: t.date?.uts ? parseInt(t.date.uts) * 1000 : Date.now(),
        nowplaying: !!t['@attr']?.nowplaying
      };
    });

    return new Response(JSON.stringify(tracks), { headers: CORS });
  }
};
