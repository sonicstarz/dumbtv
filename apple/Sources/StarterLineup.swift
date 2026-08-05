import Foundation

/// The preprogrammed starter lineup — a dial built from templates, not from
/// grouping.
///
/// ── why this is NOT the web builder, and must not become it ─────────────────
/// `public/lineup/` plans a lineup by GROUPING a library: it looks at what you
/// have, finds the shape in it, and names what it finds. That is the right tool
/// for someone sitting at a keyboard who wants their own lineup, and it runs in
/// the config UI on every platform because it never needed a server.
///
/// It is the wrong tool for a first run on a television. It needs a
/// questionnaire, it needs typing, and it produces something different for
/// everyone — none of which is what a person wants ninety seconds after
/// plugging in a box. So this is the opposite approach on purpose: a FIXED list
/// of channels a cable box would have had, each one filled from whatever in
/// your library matches it. Same endpoints, same result shape, no typing, and
/// the answer is predictable enough to put on a card and press once.
///
/// Keep it dumb. The moment this starts inferring, ranking or splitting, it has
/// become a second planner and the two will drift. If a template can't be
/// filled it is simply skipped.
enum StarterLineup {

    /// One channel a cable box would have had.
    struct Template {
        let name: String
        /// Lowercased genre words. A title matches if ANY of them appears in any
        /// of its genres — substring, so "science fiction" matches "sci".
        let genres: [String]
        /// show | movie | any — a films channel and a series channel are
        /// different products even from the same genre.
        let kind: String
        /// Only titles at or before this year, when set.
        let before: Int?
        let ordering: String
        /// Retro channels get commercials; a modern drama channel does not.
        let retro: Bool
        /// Below this a channel is a loop you notice, so it is skipped.
        let minItems: Int

        init(_ name: String, _ genres: [String], kind: String = "any",
             before: Int? = nil, ordering: String = "shuffle",
             retro: Bool = false, minItems: Int = 3) {
            self.name = name; self.genres = genres; self.kind = kind
            self.before = before; self.ordering = ordering
            self.retro = retro; self.minItems = minItems
        }
    }

    /// Twenty channels, in dial order. Deliberately a cable line-up rather than
    /// a genre taxonomy — SATURDAY MORNING and CARTOON are the same genre and a
    /// different channel, which is the whole idea.
    static let all: [Template] = [
        Template("SATURDAY MORNING", ["animation", "cartoon"], before: 1980, retro: true),
        Template("CARTOON",          ["animation", "cartoon", "anime"]),
        Template("KIDS CLUB",        ["family", "kids", "children"]),
        Template("LAUGH TRACK",      ["comedy", "sitcom"], kind: "show"),
        Template("THE COMEDY REEL",  ["comedy"], kind: "movie"),
        Template("FRONTIER",         ["western"], retro: true),
        Template("PRIME TIME",       ["action", "adventure"], kind: "show", ordering: "sequential"),
        Template("THE BIG PICTURE",  ["action", "adventure"], kind: "movie"),
        Template("OUTER LIMITS",     ["sci-fi", "science fiction", "fantasy"]),
        Template("CREATURE FEATURE", ["horror"], retro: true),
        Template("CRIME STORY",      ["crime", "mystery", "thriller"]),
        Template("THE PLAYHOUSE",    ["drama"], kind: "show", ordering: "sequential"),
        Template("MATINEE",          ["drama", "romance"], kind: "movie"),
        Template("THE RECORD",       ["documentary", "history", "biography"]),
        Template("WAR STORIES",      ["war", "military"]),
        Template("THE JUKEBOX",      ["music", "musical"]),
        Template("CLASSIC PICTURES", [], kind: "movie", before: 1970, retro: true),
        Template("LATE SHOW",        ["thriller", "horror", "mystery"], kind: "movie"),
        Template("REALITY",          ["reality", "talk", "game"]),
        Template("THE VAULT",        [], minItems: 6),   // catch-all, last resort
    ]

    /// The presets a remote can choose between. No typing, no free text — this
    /// is a first-run card on a television, so every decision is a tile.
    struct Preset: Identifiable {
        let id: String
        let title: String
        let blurb: String
        /// Which templates, by name. Empty means all of them.
        let only: [String]
        let ads: Bool

        func templates() -> [Template] {
            only.isEmpty ? all : all.filter { only.contains($0.name) }
        }
    }

    static let presets: [Preset] = [
        Preset(id: "everything", title: "THE WHOLE DIAL",
               blurb: "Up to 20 channels, built from everything you have.",
               only: [], ads: true),
        Preset(id: "classic", title: "CLASSIC TV",
               blurb: "Cartoons, westerns, sitcoms and old films — with commercials.",
               only: ["SATURDAY MORNING", "FRONTIER", "LAUGH TRACK", "CREATURE FEATURE",
                      "CLASSIC PICTURES", "THE JUKEBOX", "MATINEE"],
               ads: true),
        Preset(id: "kids", title: "KIDS",
               blurb: "Cartoons and family films. Nothing else gets a number.",
               only: ["SATURDAY MORNING", "CARTOON", "KIDS CLUB"],
               ads: false),
        Preset(id: "movies", title: "ALL FILM",
               blurb: "Every film you own, sorted onto channels by kind.",
               only: ["THE COMEDY REEL", "THE BIG PICTURE", "MATINEE",
                      "CLASSIC PICTURES", "LATE SHOW"],
               ads: false),
    ]

    /// One title from the library, flattened out of the API response.
    struct Item {
        let ratingKey: String
        let title: String
        let type: String
        let year: Int?
        let genres: [String]
    }

    /// Does this title belong on this channel?
    ///
    /// A template with no genres matches anything of the right kind and era —
    /// that is how CLASSIC PICTURES and THE VAULT work.
    static func matches(_ item: Item, _ t: Template) -> Bool {
        if t.kind != "any" && item.type != t.kind { return false }
        if let before = t.before {
            guard let y = item.year, y < before else { return false }
        }
        if t.genres.isEmpty { return true }
        return item.genres.contains { g in
            t.genres.contains { g.contains($0) || $0.contains(g) }
        }
    }

    /// Assign titles to channels, each title used ONCE, in dial order.
    ///
    /// Once-only matters: without it every comedy lands on both LAUGH TRACK and
    /// THE COMEDY REEL, and a twenty-channel dial becomes the same library
    /// shown twenty times. Earlier templates win, which is why the specific ones
    /// (SATURDAY MORNING) sit above the general ones (CARTOON) and THE VAULT is
    /// last.
    static func assign(_ items: [Item], _ templates: [Template]) -> [(Template, [Item])] {
        var used = Set<String>()
        var out: [(Template, [Item])] = []
        for t in templates {
            let picked = items.filter { !used.contains($0.ratingKey) && matches($0, t) }
            guard picked.count >= t.minItems else { continue }
            picked.forEach { used.insert($0.ratingKey) }
            out.append((t, picked))
        }
        return out
    }
}
