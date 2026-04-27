// nixan-spotify worker — Spotify Web API recently-played proxy
//
// One-time OAuth setup, then exposes GET /recent → last 5 tracks.
//
// Required bindings:
//   - env.KV                    → KV namespace (can reuse the activity worker's KV)
//   - env.SPOTIFY_CLIENT_ID     → Plaintext (from developer.spotify.com)
//   - env.SPOTIFY_CLIENT_SECRET → Secret (from developer.spotify.com)
//   - env.SPOTIFY_REDIRECT_URI  → Plaintext (e.g., https://nixan-spotify.<your-sub>.workers.dev/spotify/callback)
//
// Setup flow:
//   1. Deploy this worker
//   2. Add bindings + secrets above
//   3. On Spotify Developer Dashboard, register an app and add the callback URL as a redirect URI
//   4. Visit /spotify/login in a browser → approve → done (refresh_token gets stored in KV)
//   5. /recent now returns your last 5 tracks

const SCOPE = 'user-read-recently-played';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

function basicAuth(env) {
  return 'Basic ' + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
}

async function exchangeCode(code, env) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(env)
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.SPOTIFY_REDIRECT_URI
    })
  });
  return r.json();
}

async function refreshAccess(env) {
  const refresh_token = await env.KV.get('spotify:refresh_token');
  if (!refresh_token) return null;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(env)
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token
    })
  });
  return r.json();
}

async function getAccessToken(env) {
  const cachedRaw = await env.KV.get('spotify:access_token');
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw);
    if (cached.expiresAt > Date.now() + 60 * 1000) return cached.token;
  }
  const refreshed = await refreshAccess(env);
  if (!refreshed || !refreshed.access_token) return null;
  await env.KV.put('spotify:access_token', JSON.stringify({
    token: refreshed.access_token,
    expiresAt: Date.now() + (refreshed.expires_in * 1000)
  }));
  // Spotify sometimes rotates the refresh token — store the new one if provided
  if (refreshed.refresh_token) {
    await env.KV.put('spotify:refresh_token', refreshed.refresh_token);
  }
  return refreshed.access_token;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Step 1: kick off OAuth — browser opens this URL once
    if (url.pathname === '/spotify/login') {
      const auth = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: env.SPOTIFY_CLIENT_ID,
        response_type: 'code',
        redirect_uri: env.SPOTIFY_REDIRECT_URI,
        scope: SCOPE,
        show_dialog: 'true'
      });
      return Response.redirect(auth, 302);
    }

    // Step 2: Spotify redirects back here with ?code=...
    if (url.pathname === '/spotify/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err) return new Response('spotify error: ' + err, { status: 400 });
      if (!code) return new Response('missing code', { status: 400 });
      const result = await exchangeCode(code, env);
      if (result.refresh_token) {
        await env.KV.put('spotify:refresh_token', result.refresh_token);
        return new Response('connected. refresh_token stored — close this tab.', {
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      return new Response('failed: ' + JSON.stringify(result), {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // Public: last 5 tracks
    if (url.pathname === '/recent') {
      const token = await getAccessToken(env);
      if (!token) {
        return new Response(JSON.stringify({ error: 'not authenticated — visit /spotify/login' }), {
          status: 401,
          headers: CORS
        });
      }
      const r = await fetch('https://api.spotify.com/v1/me/player/recently-played?limit=5', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) {
        return new Response(JSON.stringify({ error: 'spotify api error', status: r.status }), {
          status: 502,
          headers: CORS
        });
      }
      const data = await r.json();
      const tracks = (data.items || []).map(item => ({
        name: item.track.name,
        artist: item.track.artists.map(a => a.name).join(', '),
        album: item.track.album.name,
        album_art: (item.track.album.images[0] || {}).url || null,
        url: item.track.external_urls.spotify,
        played_at: new Date(item.played_at).getTime()
      }));
      return new Response(JSON.stringify(tracks), { headers: CORS });
    }

    return new Response('not found', { status: 404, headers: CORS });
  }
};
