// nixan-statsfm worker — stats.fm recently-played proxy
//
// Required bindings:
//   - env.STATSFM_USER → Plaintext (your stats.fm custom id / username, the part after stats.fm/user/...)
//
// Exposes GET /recent → array of last 5 tracks, formatted for the site.
// Cached at the Cloudflare edge for 60s.
//
// Note: your stats.fm profile must be set to public for the API to return data.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    if (url.pathname !== '/recent') {
      return new Response('not found', { status: 404, headers: CORS });
    }

    if (!env.STATSFM_USER) {
      return new Response(JSON.stringify({ error: 'not configured' }), {
        status: 500, headers: CORS
      });
    }

    const endpoint = `https://api.stats.fm/api/v1/users/${encodeURIComponent(env.STATSFM_USER)}/streams/recent?limit=6`;

    let res;
    try {
      res = await fetch(endpoint, { cf: { cacheTtl: 60, cacheEverything: true } });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'fetch failed' }), { status: 502, headers: CORS });
    }
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'stats.fm error', status: res.status }), {
        status: 502, headers: CORS
      });
    }

    const data = await res.json();
    const items = data?.items || [];

    const tracks = items.slice(0, 5).map(item => {
      const t = item.track || {};
      const artists = (t.artists || []).map(a => a.name).filter(Boolean).join(', ');
      const album = (t.albums && t.albums[0]) || {};
      const album_art = album.image || null;

      const spotifyIds = t.externalIds?.spotify;
      const spotifyId = Array.isArray(spotifyIds) ? spotifyIds[0] : null;
      const url = spotifyId ? `https://open.spotify.com/track/${spotifyId}` : null;

      const played_at = item.endTime ? new Date(item.endTime).getTime() : Date.now();

      return {
        name: t.name || 'Unknown',
        artist: artists,
        album: album.name || '',
        album_art,
        url,
        spotify_id: spotifyId,
        preview_url: null,
        played_at
      };
    });

    // Enrich with preview URLs scraped from Spotify's embed page (no auth needed).
    // Spotify removed previews from many tracks in late 2024, so some will stay null.
    await Promise.all(tracks.map(async tr => {
      if (!tr.spotify_id) return;
      try {
        const r = await fetch(`https://open.spotify.com/embed/track/${tr.spotify_id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          cf: { cacheTtl: 3600, cacheEverything: true }
        });
        if (!r.ok) return;
        const html = await r.text();
        const m = html.match(/"audioPreview"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/);
        if (m && m[1]) tr.preview_url = m[1].replace(/\\u0026/g, '&');
      } catch {}
      delete tr.spotify_id;
    }));

    return new Response(JSON.stringify(tracks), { headers: CORS });
  }
};
