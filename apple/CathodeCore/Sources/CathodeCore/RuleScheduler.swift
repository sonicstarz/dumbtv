import Foundation

/// The Backend-v2 reservation scheduler, ported from `src/schedule/generator.js`.
///
/// Two passes, no side effects: pass 1 places reservations (blackout, pinned,
/// recurring, airdate) highest-priority-first, reporting anything that loses its
/// slot; pass 2 fills every gap with rotation content and ad breaks. The Node
/// version reads SQLite; here the whole library is passed in via `Library`, so
/// the logic stays pure and runs headless.

// MARK: - Rotation iterator

/// Shared across every gap in one build. Default: walk the ordered playlist with
/// a monotonic cursor, wrapping at the end. With a repeat cooldown, switch to
/// least-recently-aired selection so items are spaced out across the window and
/// across builds (seeded from persisted airings).
final class RotationIterator {
    let empty: Bool
    private let channel: ChannelConfig
    private let library: Library
    private let cooldownMs: Millis
    private let base: [Media]
    private var cursorValue: Int
    private var cachedCycle = -1
    private var cachedList: [Media]
    private var lastAired: [String: Millis] = [:]

    init(channel: ChannelConfig, library: Library, airings: [String: AiringState]) {
        self.channel = channel
        self.library = library
        self.cooldownMs = Millis(channel.cooldownDays) * DAY
        let base = buildPlaylist(channel: channel, buckets: library.sourceBuckets(), cycle: 0)
        self.base = base
        self.cachedList = base
        self.cursorValue = channel.cursor
        self.empty = base.isEmpty
        if cooldownMs > 0 {
            for (rk, st) in airings {
                if let la = st.lastAired { lastAired[rk] = la }
            }
        }
    }

    private func refresh() {
        guard !cachedList.isEmpty else { return }
        let cycle = cursorValue / cachedList.count
        if cycle != cachedCycle {
            cachedCycle = cycle
            cachedList = channel.orderingMode == .shuffle
                ? buildPlaylist(channel: channel, buckets: library.sourceBuckets(), cycle: cycle)
                : base
        }
    }

    func pickAt() -> Media? {
        if cooldownMs <= 0 {
            refresh()
            guard !cachedList.isEmpty else { return nil }
            return cachedList[cursorValue % cachedList.count]
        }
        var best: Media? = nil
        var bestLA = Millis.max
        for item in base {
            let la = lastAired[item.ratingKey] ?? Millis.min
            if la < bestLA { bestLA = la; best = item }
        }
        return best
    }

    func note(_ item: Media?, endTime: Millis) {
        cursorValue += 1
        if cooldownMs > 0, let item { lastAired[item.ratingKey] = endTime }
    }

    var cursor: Int { cursorValue }
}

// MARK: - Ad breaks

private func round5(_ ms: Millis) -> Millis {
    let five = 5 * MINUTE
    return ((ms + five / 2) / five) * five   // round-half-up for non-negative ms
}

struct BreakItem { let kind: ProgramKind; let assetId: Int?; let title: String; let durationMs: Millis }

enum Ads {
    /// Assets matching the channel's ad tags (falling back to the whole library).
    static func pool(_ channel: ChannelConfig, _ library: Library) -> [Asset] {
        let tags = channel.adTags.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        let all = library.assets.filter { $0.kind == "ad" || $0.kind == "bumper" }.sorted { $0.id < $1.id }
        if tags.isEmpty { return all }
        let tagged = all.filter { a in
            a.tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
                .contains { tags.contains($0) }
        }
        return tagged.isEmpty ? all : tagged
    }

    /// Up to `count` ads, no repeat until the pool is exhausted, each fitting `budgetMs`.
    static func pickAds(_ channel: ChannelConfig, _ pool: [Asset], seedKey: String,
                        count: Int, budgetMs: Millis) -> [BreakItem] {
        var items: [BreakItem] = []
        guard channel.adsEnabled, !pool.isEmpty, count > 0 else { return items }
        var rng = Mulberry32(seed: hashString(seedKey))
        let ads = pool.filter { $0.kind == "ad" }
        let usable = ads.isEmpty ? pool.filter { $0.kind != "bumper" } : ads
        guard !usable.isEmpty else { return items }
        var used = Set<Int>()
        var total: Millis = 0
        while items.count < count {
            var fits = usable.filter { !used.contains($0.id) && total + $0.durationMs <= budgetMs }
            if fits.isEmpty { used.removeAll(); fits = usable.filter { total + $0.durationMs <= budgetMs } }
            if fits.isEmpty { break }
            let pick = fits[Int(rng.next() * Double(fits.count))]
            used.insert(pick.id)
            items.append(BreakItem(kind: .ad, assetId: pick.id, title: pick.title, durationMs: pick.durationMs))
            total += pick.durationMs
        }
        return items
    }

    static func pickBumper(_ channel: ChannelConfig, _ pool: [Asset], seedKey: String, budgetMs: Millis) -> BreakItem? {
        guard channel.adsEnabled, !pool.isEmpty else { return nil }
        var rng = Mulberry32(seed: hashString("\(seedKey):bump"))
        let bumpers = pool.filter { $0.kind == "bumper" && $0.durationMs <= budgetMs }
        guard !bumpers.isEmpty else { return nil }
        let pick = bumpers[Int(rng.next() * Double(bumpers.count))]
        return BreakItem(kind: .bumper, assetId: pick.id, title: pick.title, durationMs: pick.durationMs)
    }

    /// A break between two programs, shaped by the channel's timing mode. Returns
    /// the items and the timestamp the block ends at (clamped to `hardEnd`).
    static func build(_ channel: ChannelConfig, _ pool: [Asset], seedKey: String,
                      programEnd: Millis, slotStart: Millis, hardEnd: Millis, clock: Clock) -> (items: [BreakItem], blockEnd: Millis) {
        let adsN = channel.adsBetween
        var items: [BreakItem] = []

        if channel.timingMode == .continuous {
            let ads = pickAds(channel, pool, seedKey: seedKey, count: adsN, budgetMs: hardEnd - programEnd)
            var end = programEnd + ads.reduce(0) { $0 + $1.durationMs }
            let bump = pickBumper(channel, pool, seedKey: seedKey, budgetMs: hardEnd - end)
            let all = bump != nil ? ads + [bump!] : ads
            end = programEnd + all.reduce(0) { $0 + $1.durationMs }
            return (all, min(end, hardEnd))
        }

        // grid / auto: fill a fixed target window.
        var target: Millis
        if channel.timingMode == .auto {
            let avg: Millis = pool.isEmpty ? 30_000
                : Millis((Double(pool.reduce(0) { $0 + $1.durationMs }) / Double(pool.count)).rounded())
            let dur = programEnd - slotStart
            let five = 5 * MINUTE
            let slotLen = max(round5(dur + Millis(adsN) * avg), ((dur + five - 1) / five) * five)
            target = slotStart + slotLen
        } else {
            target = clock.ceilToSlot(programEnd, max(5, channel.slotMinutes))
        }
        let blockEnd = min(target, hardEnd)
        var left = blockEnd - programEnd
        if left <= 0 { return (items, blockEnd) }
        let cap = max(adsN, channel.maxAdsPerBreak)
        let ads = pickAds(channel, pool, seedKey: seedKey, count: cap, budgetMs: left)
        for a in ads { items.append(a); left -= a.durationMs }
        if let bump = pickBumper(channel, pool, seedKey: seedKey, budgetMs: left) { items.append(bump); left -= bump.durationMs }
        if left > 0 { items.append(BreakItem(kind: .filler, assetId: nil, title: channel.name, durationMs: left)) }
        return (items, blockEnd)
    }
}

// MARK: - Build result

public struct BuildResult: Sendable {
    public var rows: [Program]
    public var conflicts: [Conflict]
    public var cursor: Int
    public var airingBump: [String: Int]
    public var through: Millis
    public var rotationRuleId: Int?
}

// MARK: - The two-pass builder

enum RuleScheduler {

    /// A per-channel head start (up to 20 min) so channels aren't in lock-step.
    static func staggerOffset(_ channel: ChannelConfig) -> Millis {
        var rng = Mulberry32(seed: hashString("stagger:\(channel.id):\(channel.shuffleSeed)"))
        return Millis(rng.next() * 20 * 60 * 1000)
    }

    private static func overlaps(_ a: (start: Millis, end: Millis), _ b: (start: Millis, end: Millis)) -> Bool {
        a.start < b.end && b.start < a.end
    }

    private static func parseYMD(_ s: String?) -> (Int, Int, Int)? {
        guard let s else { return nil }
        let parts = s.prefix(10).split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
        return (y, m, d)
    }

    // A concrete occurrence of a rule.
    struct Occurrence { var start: Millis; var end: Millis; var rule: ScheduleRule; var ratingKey: String? }

    // MARK: rule expansion

    /// Occurrences of a day-of-week + local start time over [from, until).
    private static func dayTimeOccurrences(_ daysCsv: String?, _ startTime: String?, _ durationMin: Int?,
                                           from: Millis, until: Millis, clock: Clock) -> [(start: Millis, end: Millis)] {
        let days = Set((daysCsv ?? "").split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) })
        guard !days.isEmpty, let startTime, let durationMin, durationMin != 0 else { return [] }
        let (sh, sm) = splitClock(startTime)
        var out: [(Millis, Millis)] = []
        // Start a day early to catch a block that began yesterday and runs in.
        var d = clock.addDays(clock.localMidnight(from), -1)
        var i = 0
        while i < 500 && d < until {
            if days.contains(clock.dayOfWeek(d)) {
                let s = clock.atTime(d, hour: sh, minute: sm)
                let e = s + Millis(durationMin) * MINUTE
                if e > from && s < until { out.append((s, e)) }
            }
            d = clock.addDays(d, 1)
            i += 1
        }
        return out
    }

    /// Air a show by its original release dates. Ported from `expandAirdate`.
    private static func expandAirdate(_ rule: ScheduleRule, library: Library,
                                      from: Millis, until: Millis, clock: Clock) -> [Occurrence] {
        guard let rk = rule.ratingKey else { return [] }
        let eps = library.showEpisodes(rk)
        if eps.isEmpty { return [] }
        let dated = eps.filter { ($0.aired ?? "").range(of: #"^\d{4}-\d{2}-\d{2}"#, options: .regularExpression) != nil }
        let mode = rule.airdateMode ?? .original_weekday
        let (sh, sm) = splitClock(rule.startTime, defaultHour: 19, defaultMinute: 0)
        var out: [Occurrence] = []

        if mode == .anniversary {
            let y0 = clock.year(from), y1 = clock.year(until)
            for e in dated {
                guard let (_, mm, dd) = parseYMD(e.aired) else { continue }
                for y in y0...y1 {
                    let start = clock.makeLocal(year: y, month: mm, day: dd, hour: sh, minute: sm)
                    let end = start + e.durationMs
                    if end > from && start < until { out.append(Occurrence(start: start, end: end, rule: rule, ratingKey: e.ratingKey)) }
                }
            }
            return out
        }

        if mode == .original_cadence {
            if dated.isEmpty { return [] }
            let compress = rule.cadenceCompress == 0 ? 1 : rule.cadenceCompress
            guard let (by, bm, bd) = parseYMD(dated[0].aired) else { return [] }
            let base = clock.makeLocal(year: by, month: bm, day: bd, hour: 0, minute: 0)
            let anchorDay: Millis
            if let (ay, am, ad) = parseYMD(rule.effectiveFrom) {
                anchorDay = clock.makeLocal(year: ay, month: am, day: ad, hour: 0, minute: 0)
            } else {
                anchorDay = clock.localMidnight(from)
            }
            let anchor = clock.atTime(anchorDay, hour: sh, minute: sm)
            let anchorMs = max(from, anchor)
            for e in dated {
                guard let (ey, em, ed) = parseYMD(e.aired) else { continue }
                let origOffset = clock.makeLocal(year: ey, month: em, day: ed, hour: 0, minute: 0) - base
                let start = anchorMs + Millis((Double(origOffset) / compress).rounded())
                let end = start + e.durationMs
                if end > from && start < until { out.append(Occurrence(start: start, end: end, rule: rule, ratingKey: e.ratingKey)) }
            }
            return out
        }

        // original_weekday
        var weekday = 6
        if !dated.isEmpty {
            var counts = Array(repeating: 0, count: 7)
            for e in dated {
                if let (y, m, d) = parseYMD(e.aired) {
                    let noon = clock.makeLocal(year: y, month: m, day: d, hour: 12, minute: 0)
                    counts[clock.dayOfWeek(noon)] += 1
                }
            }
            weekday = counts.firstIndex(of: counts.max() ?? 0) ?? 6
        } else if let dow = rule.daysOfWeek?.split(separator: ",").first, let w = Int(dow) {
            weekday = w
        }
        let seq = dated.isEmpty ? eps : dated + eps.filter { $0.aired == nil }

        // Episode index is a stable function of the calendar week, anchored to
        // effective_from (else a fixed 2020-01-06 epoch).
        var anchor: Millis
        if let (y, m, d) = parseYMD(rule.effectiveFrom) {
            anchor = clock.makeLocal(year: y, month: m, day: d, hour: 0, minute: 0)
        } else {
            anchor = clock.makeLocal(year: 2020, month: 1, day: 6, hour: 0, minute: 0)
        }
        while clock.dayOfWeek(anchor) != weekday { anchor = clock.addDays(anchor, 1) }
        let anchorMs = anchor

        var cur = clock.localMidnight(max(from - WEEK, anchorMs))
        while clock.dayOfWeek(cur) != weekday { cur = clock.addDays(cur, 1) }
        for _ in 0..<800 {
            let start = clock.atTime(cur, hour: sh, minute: sm)
            if start >= until { break }
            let midnight = clock.localMidnight(cur)
            let idx = Int((Double(midnight - anchorMs) / Double(WEEK)).rounded())
            if idx >= 0 {
                let ep = seq[((idx % seq.count) + seq.count) % seq.count]
                let end = start + ep.durationMs
                if end > from && start < until { out.append(Occurrence(start: start, end: end, rule: rule, ratingKey: ep.ratingKey)) }
            }
            cur = clock.addDays(cur, 7)
        }
        return out
    }

    /// Expand one rule into concrete [start, end) occurrences inside the window.
    private static func expandRule(_ rule: ScheduleRule, library: Library,
                                   from: Millis, until: Millis, clock: Clock) -> [Occurrence] {
        var effFrom = Millis.min
        var effTo = Millis.max
        if let (y, m, d) = parseYMD(rule.effectiveFrom) { effFrom = clock.makeLocal(year: y, month: m, day: d, hour: 0, minute: 0) }
        if let (y, m, d) = parseYMD(rule.effectiveTo) { effTo = clock.makeLocal(year: y, month: m, day: d, hour: 23, minute: 59) + 59_000 }
        let lo = max(from, effFrom)
        let hi = min(until, effTo)
        if lo >= hi { return [] }

        switch rule.kind {
        case .blackout, .recurring:
            return dayTimeOccurrences(rule.daysOfWeek, rule.startTime, rule.durationMin, from: lo, until: hi, clock: clock)
                .map { Occurrence(start: $0.start, end: $0.end, rule: rule, ratingKey: nil) }
        case .pinned:
            guard let s = rule.startsAtUtc, let rk = rule.ratingKey,
                  let m = library.mediaByKey[rk], m.durationMs > 0 else { return [] }
            let e = s + m.durationMs
            if e > lo && s < hi { return [Occurrence(start: s, end: e, rule: rule, ratingKey: rk)] }
            return []
        case .airdate:
            return expandAirdate(rule, library: library, from: lo, until: hi, clock: clock)
        case .rotation:
            return []
        }
    }

    // MARK: fill

    final class BuildContext {
        let channel: ChannelConfig
        let library: Library
        let clock: Clock
        let pool: [Asset]
        let iter: RotationIterator
        let existingAirings: [String: AiringState]
        var rows: [Program] = []
        var airingBump: [String: Int] = [:]

        init(channel: ChannelConfig, library: Library, clock: Clock, airings: [String: AiringState]) {
            self.channel = channel
            self.library = library
            self.clock = clock
            self.pool = Ads.pool(channel, library)
            self.iter = RotationIterator(channel: channel, library: library, airings: airings)
            self.existingAirings = airings
        }

        func airingNo(_ ratingKey: String) -> Int {
            let existing = existingAirings[ratingKey]?.count ?? 0
            let bumped = airingBump[ratingKey] ?? 0
            airingBump[ratingKey] = bumped + 1
            return existing + bumped + 1
        }

        func pushProgram(_ item: Media, start: Millis, durationOverride: Millis? = nil,
                         blockStart: Millis, ruleId: Int?) {
            let dur = durationOverride ?? item.durationMs
            let airing = airingNo(item.ratingKey)
            rows.append(Program(
                channelId: channel.id, startUtc: start, endUtc: start + dur,
                kind: item.kind == .movie ? .movie : .episode, ratingKey: item.ratingKey,
                assetId: nil, title: item.showTitle ?? item.title,
                subtitle: item.showTitle != nil ? item.title : nil,
                seasonNo: item.seasonNo, episodeNo: item.episodeNo,
                slotStart: blockStart, ruleId: ruleId, airingNo: airing))
        }

        func pushSpan(_ kind: ProgramKind, start: Millis, end: Millis, title: String,
                      subtitle: String? = nil, ruleId: Int?, assetId: Int? = nil, slotStart: Millis? = nil) {
            rows.append(Program(
                channelId: channel.id, startUtc: start, endUtc: end, kind: kind,
                ratingKey: nil, assetId: assetId, title: title, subtitle: subtitle,
                seasonNo: nil, episodeNo: nil, slotStart: slotStart ?? start,
                ruleId: ruleId, airingNo: 1))
        }
    }

    /// Fill [start, end) with rotation content back-to-back, plus ad breaks.
    private static func fillWindow(_ ctx: BuildContext, ruleId: Int?, start: Millis, end: Millis, cut: Bool) {
        var t = start
        var guardCount = 0
        while t < end && guardCount < 50000 {
            guardCount += 1
            let picked = ctx.iter.pickAt()
            guard let item = picked, item.durationMs > 0 else {
                ctx.iter.note(picked, endTime: t); continue
            }
            if t + item.durationMs > end {
                // Won't fit. protect leaves it for later; cutin airs it and hard-cuts.
                if cut {
                    ctx.iter.note(item, endTime: end)
                    ctx.pushProgram(item, start: t, durationOverride: end - t, blockStart: t, ruleId: ruleId)
                    t = end
                }
                break
            }
            let blockStart = t
            let programEnd = t + item.durationMs
            ctx.pushProgram(item, start: t, blockStart: blockStart, ruleId: ruleId)
            ctx.iter.note(item, endTime: programEnd)
            t = programEnd
            let (items, blockEnd) = Ads.build(ctx.channel, ctx.pool, seedKey: "\(ctx.channel.id):\(blockStart)",
                                              programEnd: programEnd, slotStart: blockStart, hardEnd: end, clock: ctx.clock)
            for bi in items {
                if t + bi.durationMs > end { break }
                ctx.pushSpan(bi.kind, start: t, end: t + bi.durationMs, title: bi.title, ruleId: ruleId,
                             assetId: bi.assetId, slotStart: blockStart)
                t += bi.durationMs
            }
            t = max(t, min(blockEnd, end))
        }
        if t < end { ctx.pushSpan(.filler, start: t, end: end, title: ctx.channel.name, ruleId: ruleId) }
    }

    private static func fillRange(_ ctx: BuildContext, ruleId: Int?, start: Millis, end: Millis, cut: Bool = false) {
        if start >= end { return }
        if ctx.iter.empty {
            ctx.pushSpan(.offair, start: start, end: end, title: "No content selected",
                         subtitle: "Add shows or movies to this channel", ruleId: ruleId)
            return
        }
        fillWindow(ctx, ruleId: ruleId, start: start, end: end, cut: cut)
    }

    private static func emitReservation(_ ctx: BuildContext, _ res: Occurrence, until: Millis) {
        let end = min(res.end, until)
        if res.start >= end { return }
        let rule = res.rule
        if rule.kind == .blackout {
            ctx.pushSpan(.offair, start: res.start, end: end, title: "Off air", ruleId: rule.id)
            return
        }
        let rk = res.ratingKey ?? (rule.kind == .pinned ? rule.ratingKey : nil)
        if let rk {
            if let m = ctx.library.mediaByKey[rk] {
                ctx.pushProgram(m, start: res.start, blockStart: res.start, ruleId: rule.id)
                if res.start + m.durationMs < end {
                    ctx.pushSpan(.filler, start: res.start + m.durationMs, end: end, title: ctx.channel.name, ruleId: rule.id)
                }
            } else {
                ctx.pushSpan(.offair, start: res.start, end: end, title: rule.name ?? "Scheduled", ruleId: rule.id)
            }
            return
        }
        // recurring: fill the reserved block with rotation content.
        fillRange(ctx, ruleId: rule.id, start: res.start, end: end)
    }

    /// Two-pass reserve-then-fill. Returns rows + conflicts; the caller commits.
    static func buildChannelPrograms(channel: ChannelConfig, rules: [ScheduleRule], library: Library,
                                     airings: [String: AiringState], from: Millis, until: Millis,
                                     clock: Clock) -> BuildResult {
        let enabledRules = rules.filter { $0.enabled }.sorted {
            $0.priority != $1.priority ? $0.priority > $1.priority : $0.id < $1.id
        }
        let rotationRule = enabledRules.first { $0.kind == .rotation }

        // Pass 1 — reservations.
        var reservations: [Occurrence] = []
        var conflicts: [Conflict] = []
        for rule in enabledRules where rule.kind != .rotation {
            for occ in expandRule(rule, library: library, from: from, until: until, clock: clock) {
                if let clash = reservations.first(where: { overlaps(($0.start, $0.end), (occ.start, occ.end)) }) {
                    conflicts.append(Conflict(rule: rule.name ?? rule.kind.rawValue, at: occ.start,
                                              lostTo: clash.rule.name ?? clash.rule.kind.rawValue))
                } else {
                    reservations.append(occ)
                }
            }
        }
        reservations.sort { $0.start < $1.start }

        // Pass 2 — fill.
        let ctx = BuildContext(channel: channel, library: library, clock: clock, airings: airings)
        var t = from
        var ri = 0
        var guardCount = 0
        while t < until && guardCount < 200000 {
            guardCount += 1
            guard ri < reservations.count, reservations[ri].start < until else {
                fillRange(ctx, ruleId: rotationRule?.id, start: t, end: until)
                t = until
                break
            }
            let res = reservations[ri]
            if t < res.start {
                let cut = channel.overrunPolicy == .cutin &&
                    [RuleKind.pinned, .blackout, .airdate].contains(res.rule.kind)
                fillRange(ctx, ruleId: rotationRule?.id, start: t, end: res.start, cut: cut)
                t = res.start
            }
            emitReservation(ctx, res, until: until)
            t = max(t, min(res.end, until))
            ri += 1
        }

        return BuildResult(rows: ctx.rows, conflicts: conflicts, cursor: ctx.iter.cursor,
                           airingBump: ctx.airingBump, through: t, rotationRuleId: rotationRule?.id)
    }
}
