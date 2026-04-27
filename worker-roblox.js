// nixan-roblox worker — Roblox public API proxy
//
// Required bindings:
//   - env.ROBLOX_USERNAME   → Plaintext (e.g. "IINixanII")
//   - env.ROBLOSECURITY     → Secret (your .ROBLOSECURITY cookie value, no name=, just the value)
//   - env.KV                → KV namespace (can reuse the activity/spotify KV)
//
// Exposes GET /user → user info, presence, RAP, friend counts, last played.
// Edge cache 30s; KV remembers last_played even when offline.
//
// SECURITY: .ROBLOSECURITY grants full account access. Always store as a
// Secret (not Plaintext). Rotate it if you suspect leakage.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

const j = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

function authHeaders(env) {
  const h = { 'Content-Type': 'application/json' };
  if (env.ROBLOSECURITY) {
    h['Cookie'] = `.ROBLOSECURITY=${env.ROBLOSECURITY}`;
  }
  return h;
}

const safeJson = (url, env, useAuth = false) =>
  fetch(url, {
    headers: useAuth ? authHeaders(env) : { 'Content-Type': 'application/json' }
  })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

const safePost = (url, body, env, useAuth = false) =>
  fetch(url, {
    method: 'POST',
    headers: useAuth ? authHeaders(env) : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

async function computeRap(userId, env) {
  // Sum recentAveragePrice across the user's collectibles.
  // Public inventory endpoint requires no auth IF inventory is public,
  // but using the cookie also works and avoids 403s when inventory is private-to-friends.
  let total = 0;
  let cursor = '';
  let pages = 0;
  do {
    const url =
      `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?sortOrder=Asc&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const data = await safeJson(url, env, true);
    if (!data?.data) return null;
    for (const item of data.data) {
      if (typeof item.recentAveragePrice === 'number') total += item.recentAveragePrice;
    }
    cursor = data.nextPageCursor || '';
    pages++;
  } while (cursor && pages < 10); // hard cap at 1000 items
  return total;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    if (url.pathname !== '/user') return j({ error: 'not found' }, 404);
    if (!env.ROBLOX_USERNAME) return j({ error: 'not configured' }, 500);

    // 1. Resolve username → user ID
    const idData = await safePost(
      'https://users.roblox.com/v1/usernames/users',
      { usernames: [env.ROBLOX_USERNAME], excludeBannedUsers: false },
      env
    );
    const u = idData?.data?.[0];
    if (!u) return j({ error: 'user not found' }, 404);
    const userId = u.id;

    // 2. Fetch everything in parallel
    //    Presence + RAP need auth (cookie). Others are public.
    const [info, friends, followers, following, presenceRes, avatarRes, rap] =
      await Promise.all([
        safeJson(`https://users.roblox.com/v1/users/${userId}`, env),
        safeJson(`https://friends.roblox.com/v1/users/${userId}/friends/count`, env),
        safeJson(`https://friends.roblox.com/v1/users/${userId}/followers/count`, env),
        safeJson(`https://friends.roblox.com/v1/users/${userId}/followings/count`, env),
        safePost(
          'https://presence.roblox.com/v1/presence/users',
          { userIds: [userId] },
          env,
          true
        ),
        safeJson(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`,
          env
        ),
        env.ROBLOSECURITY ? computeRap(userId, env) : Promise.resolve(null)
      ]);

    const p = presenceRes?.userPresences?.[0] || {};

    // 3. Build "currently playing" payload (if in-game) and remember it in KV.
    let placeIcon = null;
    if (p.placeId) {
      const iconRes = await safeJson(
        `https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${p.placeId}&size=150x150&format=Png&isCircular=false`,
        env
      );
      placeIcon = iconRes?.data?.[0]?.imageUrl || null;
    }

    const inGame = p.userPresenceType === 2 || p.userPresenceType === 3;
    let lastPlayed = null;

    if (inGame && p.placeId) {
      lastPlayed = {
        place_id: p.placeId,
        location: p.lastLocation || '',
        place_icon: placeIcon,
        game_id: p.gameId || null,
        timestamp: Date.now()
      };
      if (env.KV) {
        await env.KV.put('roblox:last_played', JSON.stringify(lastPlayed));
      }
    } else if (env.KV) {
      const cached = await env.KV.get('roblox:last_played');
      if (cached) {
        try { lastPlayed = JSON.parse(cached); } catch {}
      }
    }

    return new Response(
      JSON.stringify({
        id: userId,
        name: u.name,
        display_name: u.displayName || u.name,
        created: info?.created || null,
        avatar_url: avatarRes?.data?.[0]?.imageUrl || null,
        friends: friends?.count ?? null,
        followers: followers?.count ?? null,
        following: following?.count ?? null,
        rap: rap, // null if cookie not configured or inventory hidden
        presence: {
          // 0 = Offline, 1 = Online, 2 = InGame, 3 = InStudio, 4 = Invisible
          state: p.userPresenceType ?? 0,
          location: p.lastLocation || '',
          place_id: p.placeId ?? null,
          place_icon: placeIcon,
          game_id: p.gameId ?? null,
          last_online: p.lastOnline || null
        },
        last_played: lastPlayed
      }),
      { headers: { ...CORS, 'Cache-Control': 'public, max-age=30' } }
    );
  }
};
