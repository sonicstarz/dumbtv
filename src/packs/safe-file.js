// safe-file.js — the one rule about a pack item's `file` field.
//
// A pack manifest names a file per item, and installing joins that name onto the
// pack's directory. That value is NOT ours: the download catalog lives at
// dumbtv.app/packs/index.json (D5), so from the moment curation moves off the
// bundled copy it arrives over the network. `path.join(dir, '../../../evil')`
// resolves outside the pack directory and writes wherever it points — so the
// name has to be exactly a filename and nothing else.
//
// Deliberately dependency-free (no db, no config) so the build script can assert
// the identical rule at authoring time without opening a database.

import path from 'node:path';

/**
 * Throw unless `file` is a plain filename — no directory parts, no traversal,
 * no leading dot. Returns the name so it can be used inline.
 *
 * @param {unknown} file     the manifest's `file` value
 * @param {string}  context  what to name in the error (e.g. "pack superman/item mad-scientist")
 */
export function assertSafePackFile(file, context = 'pack item') {
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(`${context}: file is missing`);
  }
  // Explicit separator check first: path.basename is platform-specific, and a
  // backslash means nothing to it on POSIX while meaning everything on Windows.
  if (file.includes('/') || file.includes('\\')) {
    throw new Error(`${context}: file must be a plain filename, got "${file}"`);
  }
  if (file !== path.basename(file)) {
    throw new Error(`${context}: file must be a plain filename, got "${file}"`);
  }
  // Catches "." and ".." (which ARE their own basename) plus hidden files.
  if (file.startsWith('.')) {
    throw new Error(`${context}: file must not start with a dot, got "${file}"`);
  }
  if (file.includes('\0')) {
    throw new Error(`${context}: file contains a null byte`);
  }
  return file;
}
