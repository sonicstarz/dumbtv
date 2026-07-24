import { db, getSetting, setSetting, deleteSetting } from '../db.js';

// Jellyfin identifies clients with this header on every request. DeviceId is
// stable so Jellyfin shows one "dumbTV" device rather than a new one each boot.
export const JF_AUTH_HEADER =
  'MediaBrowser Client="dumbTV", Device="dumbTV", DeviceId="dumbtv-headend", Version="1.0"';

function trimUrl(u) {
  return String(u || '').replace(/\/+$/, '');
}

/**
 * Log in to a Jellyfin server with a username and password. Jellyfin returns an
 * access token and the user id; we store both plus the base URL. (An API key
 * created in the Jellyfin dashboard also works — see saveServer.)
 */
export async function authenticate(url, username, password) {
  const base = trimUrl(url);
  if (!base) throw new Error('Enter your Jellyfin server address.');
  const res = await fetch(`${base}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': JF_AUTH_HEADER,
    },
    body: JSON.stringify({ Username: username, Pw: password || '' }),
  });
  if (!res.ok) throw new Error(`Jellyfin rejected the login (${res.status})`);
  const data = await res.json();
  if (!data.AccessToken || !data.User) throw new Error('Jellyfin did not return a token.');
  const server = { url: base, token: data.AccessToken, userId: data.User.Id, name: data.User.Name };
  saveServer(server);
  return server;
}

/** Alternatively, connect with a server URL, user id, and a dashboard API key. */
export async function saveApiKey(url, userId, apiKey) {
  const base = trimUrl(url);
  const server = { url: base, token: apiKey, userId, name: 'API key' };
  saveServer(server);
  return server;
}

export function saveServer(server) {
  setSetting('jellyfin_server', server);
}

export function getJfServer() {
  return getSetting('jellyfin_server', null);
}

export function clearJf() {
  deleteSetting('jellyfin_server');
}

export function jfConfigured() {
  const s = getJfServer();
  return !!(s && s.url && s.token && s.userId);
}
