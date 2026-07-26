// filename.js — turn a media filename into title/show/season/episode, with NO
// network metadata lookups (Track I, P5). The parsing rules ARE the contract:
// name your files this way and dumbTV understands them. The Swift port
// (apple/dumbTVCore/Sources/dumbTVCore/Filenames.swift) mirrors this exactly;
// scripts/filename-vectors.json is the shared test table both sides assert.
//
// Rules (first match wins):
//   • S01E02 / s1e2 / 1x02        → episode; text before = show, after = title
//   • "Title (1994)"              → movie, year 1994
//   • otherwise                   → movie titled after the file (show = folder)

const EP_PATTERNS = [
  /^(?<show>.*?)[ ._-]*[Ss](?<s>\d{1,2})[ ._-]*[Ee](?<e>\d{1,3})[ ._-]*(?<title>.*)$/,
  /^(?<show>.*?)[ ._-]+(?<s>\d{1,2})x(?<e>\d{1,3})[ ._-]*(?<title>.*)$/,
];

function clean(s) {
  return String(s || '')
    .replace(/[._]+/g, ' ')       // dots/underscores → spaces
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–]+|[\s\-–]+$/g, '')
    .trim();
}

/**
 * @param {string} filename  a basename, e.g. "The Bat Channel S01E02 Nothing to Fear.mkv"
 * @param {string} [folder]  its folder name, used as the show fallback
 * @returns {{kind:'episode'|'movie', title:string, showTitle:string|null,
 *            seasonNo:number|null, episodeNo:number|null, year:number|null}}
 */
export function parseFilename(filename, folder = '') {
  const base = String(filename).replace(/\.[a-z0-9]{2,4}$/i, ''); // drop extension
  const folderName = clean(folder);

  for (const re of EP_PATTERNS) {
    const m = re.exec(base);
    if (m) {
      const show = clean(m.groups.show) || folderName || 'Untitled';
      const epTitle = clean(m.groups.title);
      const seasonNo = Number(m.groups.s);
      const episodeNo = Number(m.groups.e);
      return {
        kind: 'episode',
        showTitle: show,
        seasonNo,
        episodeNo,
        title: epTitle || `Episode ${episodeNo}`,
        year: null,
      };
    }
  }

  // Movie "Title (YYYY)" or a bare title.
  const ym = base.match(/\((\d{4})\)/) || base.match(/\b(19\d{2}|20\d{2})\b/);
  const year = ym ? Number(ym[1]) : null;
  const title = clean(base.replace(/\(?\b(19\d{2}|20\d{2})\b\)?/, '')) || clean(base) || 'Untitled';
  return { kind: 'movie', title, showTitle: folderName || null, seasonNo: null, episodeNo: null, year };
}
