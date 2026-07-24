import { PLEX_HEADERS } from '../config.js';
import { getSetting, setSetting, deleteSetting } from '../db.js';

const PLEX_TV = 'https://plex.tv/api/v2';

/**
 * Start the PIN link flow. The user enters the returned code at
 * plex.tv/link — no password ever touches this app.
 */
export async function createPin() {
  // No strong=true: that returns a long code meant for the app.plex.tv/auth
  // redirect. We want the short 4-character code you can type at plex.tv/link,
  // which is the UX the config app shows.
  const res = await fetch(`${PLEX_TV}/pins`, {
    method: 'POST',
    headers: PLEX_HEADERS,
  });
  if (!res.ok) throw new Error(`Plex refused the PIN request (${res.status})`);
  const data = await res.json();
  return { id: data.id, code: data.code, expiresAt: data.expiresAt };
}

/** Poll until the user finishes linking. Returns a token, or null if not yet. */
export async function checkPin(id) {
  const res = await fetch(`${PLEX_TV}/pins/${id}`, { headers: PLEX_HEADERS });
  if (!res.ok) throw new Error(`Could not check the PIN (${res.status})`);
  const data = await res.json();
  return data.authToken || null;
}

export function saveToken(token) {
  setSetting('plex_token', token);
}

export function getToken() {
  return getSetting('plex_token', null);
}

export function clearAuth() {
  deleteSetting('plex_token');
  deleteSetting('plex_server');
}

export function saveServer(server) {
  setSetting('plex_server', server);
}

export function getServer() {
  return getSetting('plex_server', null);
}

/**
 * Every server the account can reach, with the connection we should prefer.
 * Local addresses beat remote; relay is last and gets flagged, because relay
 * cannot sustain direct play and direct play is the whole trick.
 */
export async function listServers(token) {
  const res = await fetch(
    `${PLEX_TV}/resources?includeHttps=1&includeRelay=1`,
    { headers: { ...PLEX_HEADERS, 'X-Plex-Token': token } }
  );
  if (!res.ok) throw new Error(`Could not list servers (${res.status})`);
  const data = await res.json();

  return data
    .filter((r) => r.provides && r.provides.includes('server'))
    .map((r) => {
      const conns = (r.connections || []).slice().sort((a, b) => {
        const score = (c) => (c.relay ? 2 : c.local ? 0 : 1);
        return score(a) - score(b);
      });
      const best = conns[0];
      return {
        name: r.name,
        clientIdentifier: r.clientIdentifier,
        accessToken: r.accessToken || token,
        uri: best ? best.uri : null,
        local: best ? !!best.local : false,
        relayOnly: conns.length > 0 && conns.every((c) => c.relay),
        connections: conns.map((c) => ({
          uri: c.uri,
          local: !!c.local,
          relay: !!c.relay,
        })),
      };
    })
    .filter((s) => s.uri);
}
