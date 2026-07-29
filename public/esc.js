// esc.js — HTML escaping, shared by the config app and the television.
//
// Both build markup with template strings and innerHTML, and the values they
// interpolate are not ours: titles come from Plex/Jellyfin metadata, from
// FILENAMES on a scanned local folder, and from pack manifests — which are
// fetched from dumbtv.app once the live catalog ships. A file called
// `<img src=x onerror=…>.mp4` is a perfectly legal filename.
//
// One definition, imported by both, so the two pages cannot drift apart again.

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
