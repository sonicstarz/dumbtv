#if os(macOS)
import AppKit
import dumbTVCore

/// The one native moment in "bring your own files" (Track I, P6).
///
/// A sandboxed Mac app cannot be told about a folder — it has to be GIVEN one,
/// through a real NSOpenPanel, and the permission that comes back only survives
/// a relaunch as a security-scoped bookmark. No amount of typing a path in the
/// web UI can substitute: the browser is on a different device, and even on the
/// same machine a path string carries no permission.
///
/// So the split, decided in the Track I open questions, is: GRANT ONCE HERE,
/// MANAGE EVERYWHERE ELSE. This file is the whole native surface. Listing the
/// folders, rescanning them, building a channel from one and removing it all
/// happen over `/api/local-folders` in the same web UI as the rest of the
/// configuration.
enum FolderGrant {

    /// Show the picker, keep the permission, scan what's inside, and register
    /// it as a channel source. Returns the folder key, or nil if cancelled.
    @MainActor
    static func pick(store: Store) async -> String? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use This Folder"
        panel.message = "Choose a folder of video files. dumbTV will keep permission to read it, and nothing leaves your Mac."

        guard panel.runModal() == .OK, let url = panel.url else { return nil }

        // The bookmark IS the permission. Without it the grant dies with the
        // process and the channel silently stops playing after a relaunch —
        // which would look like a bug rather than a lost permission.
        guard let bookmark = try? url.bookmarkData(options: [.withSecurityScope],
                                                   includingResourceValuesForKeys: nil,
                                                   relativeTo: nil) else {
            present("dumbTV could not keep permission for that folder.",
                    detail: "Try a folder inside your home directory.")
            return nil
        }

        let folderId = store.localFolderId(url.path)
        store.saveGrantedFolder(folderId: folderId, path: url.path, bookmark: bookmark)

        // Read it now so the web UI has something to show immediately. The
        // panel already granted access for this session, so no resolve needed.
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }

        let items = await Store.scanFolder(url)
        _ = store.registerLocalFolder(rootPath: url.path, items: items)
        store.noteFolderScanned(folderId, itemCount: items.count)

        if items.isEmpty {
            present("No playable video in that folder.",
                    detail: "dumbTV looked for mp4, mkv, avi, mov, m4v, webm, mpg and ogv files, including in sub-folders. The folder is still added — put files in it and rescan from the setup page.")
        } else {
            present("Added \(items.count) item\(items.count == 1 ? "" : "s") from \(url.lastPathComponent).",
                    detail: "Build a channel from it on the setup page, under Local Folders.")
        }
        return folderId
    }

    @MainActor
    private static func present(_ text: String, detail: String) {
        let a = NSAlert()
        a.messageText = text
        a.informativeText = detail
        a.addButton(withTitle: "OK")
        a.runModal()
    }
}
#endif
