import Foundation

// Filenames.swift — the Swift port of src/media/filename.js (Track I, P5/P6).
// One naming spec, two implementations; scripts/filename-vectors.json is the
// shared table both assert against. NO network metadata lookups.

public struct ParsedName: Equatable, Sendable {
    public var kind: MediaKind
    public var title: String
    public var showTitle: String?
    public var seasonNo: Int?
    public var episodeNo: Int?
    public var year: Int?
}

public enum Filenames {
    // (show)(SxxEyy)(title)  and  (show)(NxM)(title)
    private static let episodePatterns = [
        "^(.*?)[ ._-]*[Ss]([0-9]{1,2})[ ._-]*[Ee]([0-9]{1,3})[ ._-]*(.*)$",
        "^(.*?)[ ._-]+([0-9]{1,2})x([0-9]{1,3})[ ._-]*(.*)$",
    ]

    static func clean(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "[._]+", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: " {2,}", with: " ", options: .regularExpression)
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: " -–\t"))
        return t
    }

    public static func parse(_ filename: String, folder: String = "") -> ParsedName {
        let base = filename.replacingOccurrences(of: "\\.[a-z0-9]{2,4}$", with: "", options: [.regularExpression, .caseInsensitive])
        let folderName = clean(folder)

        for pat in episodePatterns {
            guard let re = try? NSRegularExpression(pattern: pat),
                  let m = re.firstMatch(in: base, range: NSRange(base.startIndex..., in: base)),
                  m.numberOfRanges == 5 else { continue }
            func grp(_ i: Int) -> String { Range(m.range(at: i), in: base).map { String(base[$0]) } ?? "" }
            let show = clean(grp(1)).isEmpty ? (folderName.isEmpty ? "Untitled" : folderName) : clean(grp(1))
            let season = Int(grp(2)) ?? 1
            let episode = Int(grp(3)) ?? 1
            let epTitle = clean(grp(4))
            return ParsedName(kind: .episode, title: epTitle.isEmpty ? "Episode \(episode)" : epTitle,
                              showTitle: show, seasonNo: season, episodeNo: episode, year: nil)
        }

        // Movie "Title (YYYY)" or bare title.
        let year = firstYear(in: base)
        var title = base.replacingOccurrences(of: "\\(?\\b(19[0-9]{2}|20[0-9]{2})\\b\\)?", with: "", options: .regularExpression)
        title = clean(title)
        if title.isEmpty { title = clean(base) }
        if title.isEmpty { title = "Untitled" }
        return ParsedName(kind: .movie, title: title, showTitle: folderName.isEmpty ? nil : folderName,
                          seasonNo: nil, episodeNo: nil, year: year)
    }

    private static func firstYear(in s: String) -> Int? {
        guard let re = try? NSRegularExpression(pattern: "(19[0-9]{2}|20[0-9]{2})"),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              let r = Range(m.range(at: 1), in: s) else { return nil }
        return Int(s[r])
    }
}
