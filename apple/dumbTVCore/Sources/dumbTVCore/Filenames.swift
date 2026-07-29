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

        // Movie "Title (YYYY)", or a bare year at the END of the name.
        //
        // The strip used to be unanchored and took the FIRST year anywhere,
        // which ate titles that ARE years: "2001 A Space Odyssey (1968)" lost
        // the 2001 and came out as "A Space Odyssey" dated 2001. A parenthesised
        // year is unambiguous; a bare one only counts trailing.
        var year: Int?
        var stripped = base
        if let (y, range) = match(in: base, pattern: "\\((19[0-9]{2}|20[0-9]{2})\\)") {
            year = y
            stripped = base.replacingCharacters(in: range, with: "")
        } else if let (y, range) = match(in: base, pattern: "[ ._-](19[0-9]{2}|20[0-9]{2})\\s*$") {
            year = y
            stripped = String(base[base.startIndex..<range.lowerBound])
        }
        var title = clean(stripped)
        if title.isEmpty { title = clean(base) }
        if title.isEmpty { title = "Untitled" }
        return ParsedName(kind: .movie, title: title, showTitle: folderName.isEmpty ? nil : folderName,
                          seasonNo: nil, episodeNo: nil, year: year)
    }

    /// The captured year plus the range of the WHOLE match, so the caller can cut it out.
    private static func match(in s: String, pattern: String) -> (Int, Range<String.Index>)? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              let whole = Range(m.range, in: s),
              let cap = Range(m.range(at: 1), in: s),
              let y = Int(s[cap]) else { return nil }
        return (y, whole)
    }
}
