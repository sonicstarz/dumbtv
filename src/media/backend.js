import { getSetting } from '../db.js';
import * as plex from '../plex/client.js';
import * as jelly from '../jellyfin/client.js';

// One media backend is active at a time — Plex or Jellyfin — chosen by the
// 'media_backend' setting. Everything that talks to the server (browse, cache,
// images) goes through the active one. Direct-play only, both sides.

export function activeBackend() {
  return getSetting('media_backend', 'plex') === 'jellyfin' ? 'jellyfin' : 'plex';
}

function active() {
  return activeBackend() === 'jellyfin' ? jelly : plex;
}

export const ping = (...a) => active().ping(...a);
export const getSections = (...a) => active().getSections(...a);
export const getSectionItems = (...a) => active().getSectionItems(...a);
export const cacheSource = (...a) => active().cacheSource(...a);
export const getAllEpisodes = (...a) => active().getAllEpisodes(...a);
export const getMovie = (...a) => active().getMovie(...a);
export const getSectionAds = (...a) => active().getSectionAds(...a);
export const imageUrl = (...a) => active().imageUrl(...a);

// Ad import differs by name between backends.
export const importAds = (sectionKey) =>
  activeBackend() === 'jellyfin' ? jelly.importJellyfinAds(sectionKey) : plex.importPlexAds(sectionKey);

// Stream URLs dispatch on the part-key shape, NOT the active backend: a Jellyfin
// key (jf:…) always builds a Jellyfin URL and a Plex key a Plex URL. That way a
// schedule cached under one backend still plays if you switch, and mixed rows
// (e.g. Plex shows + a Jellyfin ad library) each resolve correctly.
export function streamUrl(partKey) {
  if (typeof partKey === 'string' && partKey.startsWith('jf:')) return jelly.streamUrl(partKey);
  return plex.streamUrl(partKey);
}
