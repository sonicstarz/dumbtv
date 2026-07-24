import Foundation

/// A stateful, in-memory channel schedule — the Swift counterpart of the
/// SQLite-backed generator in `src/schedule/generator.js`. It owns the
/// append-only `programs` timeline, the rotation cursor, and per-item airing
/// state, and exposes `generateChannel` / `regenerateChannel` / `preview` with
/// the same semantics the Node backend commits to the database.
///
/// Invariants preserved from CLAUDE.md:
///  • append-only — a top-up never rewrites an already-generated program;
///  • deterministic — the same seed produces the same schedule byte-for-byte;
///  • hole-fill — if nothing is airing *now*, stray future rows are dropped and
///    the schedule rebuilds from the leading edge.
public final class ChannelScheduler {
    public private(set) var channel: ChannelConfig
    public private(set) var rules: [ScheduleRule]
    public var library: Library
    public private(set) var programs: [Program] = []
    public private(set) var airings: [String: AiringState] = [:]
    public var windowDays: Int
    let clock: Clock
    private var nextRuleId: Int

    public init(channel: ChannelConfig, rules: [ScheduleRule] = [], library: Library = Library(),
                windowDays: Int = 14, clock: Clock = .device) {
        self.channel = channel
        self.rules = rules
        self.library = library
        self.windowDays = windowDays
        self.clock = clock
        self.nextRuleId = (rules.map { $0.id }.max() ?? 0) + 1
        ensureChannelRules()
    }

    // MARK: rule management

    /// Synthesise a channel's default rules if it has none: a rotation rule from
    /// its ordering, and a blackout rule from any dark hours. Idempotent.
    private func ensureChannelRules() {
        guard rules.isEmpty else { return }
        rules.append(ScheduleRule(id: nextRuleId, channelId: channel.id, name: "Everything else",
                                  kind: .rotation, priority: 0, orderingMode: channel.orderingMode,
                                  cursor: channel.cursor))
        nextRuleId += 1
        if let ds = channel.darkStart, let de = channel.darkEnd {
            rules.append(ScheduleRule(id: nextRuleId, channelId: channel.id, name: "Off air",
                                      kind: .blackout, priority: 1000, daysOfWeek: "0,1,2,3,4,5,6",
                                      startTime: ds, durationMin: minutesBetween(ds, de)))
            nextRuleId += 1
        }
    }

    @discardableResult
    public func addRule(_ rule: ScheduleRule) -> Int {
        var r = rule
        r.id = nextRuleId
        r.channelId = channel.id
        nextRuleId += 1
        rules.append(r)
        return r.id
    }

    public func removeRule(id: Int) {
        rules.removeAll { $0.id == id && $0.kind != .rotation }
    }

    // MARK: generation

    public struct GenResult: Sendable {
        public var added: Int
        public var through: Millis
        public var conflicts: [Conflict]
    }

    /// Extend the schedule forward to `until`. Append-only.
    @discardableResult
    public func generateChannel(now: Millis, until: Millis) -> GenResult {
        ensureChannelRules()

        // What's airing right now? Trust the programs table, not generated_thru:
        // if nothing is on at `now`, drop stray future rows and rebuild from the
        // leading edge so any hole gets filled.
        let onNow = programs.filter { $0.startUtc <= now && $0.endUtc > now }.map { $0.endUtc }.max()

        var from: Millis
        if let onNow {
            from = (channel.generatedThru > now) ? channel.generatedThru : onNow
        } else {
            programs.removeAll { $0.startUtc >= now }
            from = now - RuleScheduler.staggerOffset(channel)
        }
        if from >= until { return GenResult(added: 0, through: channel.generatedThru, conflicts: []) }

        let built = RuleScheduler.buildChannelPrograms(
            channel: channel, rules: rules, library: library, airings: airings,
            from: from, until: until, clock: clock)

        // Commit.
        programs.append(contentsOf: built.rows)
        programs.sort { $0.startUtc < $1.startUtc }
        channel.cursor = built.cursor
        channel.generatedThru = built.through
        if let rid = built.rotationRuleId, let i = rules.firstIndex(where: { $0.id == rid }) {
            rules[i].cursor = built.cursor
        }
        for (rk, n) in built.airingBump {
            let lastEnd = built.rows.filter { $0.ratingKey == rk }.map { $0.endUtc }.max() ?? 0
            var st = airings[rk] ?? AiringState()
            st.count += n
            st.lastAired = max(st.lastAired ?? 0, lastEnd)
            airings[rk] = st
        }

        return GenResult(added: built.rows.count, through: built.through, conflicts: built.conflicts)
    }

    /// Throw away everything not yet aired and rebuild from the leading edge.
    @discardableResult
    public func regenerateChannel(now: Millis) -> GenResult {
        programs.removeAll { $0.startUtc >= now || $0.title == "No content selected" }
        let last = programs.filter { $0.startUtc < now }.map { $0.endUtc }.max()
        channel.generatedThru = last ?? now
        return generateChannel(now: now, until: now + Millis(windowDays) * DAY)
    }

    /// Dry run: what a rebuild would produce over the next `days`, no side effects.
    public func preview(now: Millis, days: Int = 7) -> (from: Millis, until: Millis, result: BuildResult) {
        let last = programs.filter { $0.startUtc < now }.map { $0.endUtc }.max()
        let from = (last != nil && last! > now) ? last! : now
        let until = from + Millis(days) * DAY
        let built = RuleScheduler.buildChannelPrograms(
            channel: channel, rules: rules, library: library, airings: airings,
            from: from, until: until, clock: clock)
        return (from, until, built)
    }

    // MARK: reads

    public func nowOn(at: Millis) -> Airing? { Resolver.nowOn(programs, at: at) }
    public func upNext(at: Millis, count: Int = 1) -> [Program] { Resolver.upNext(programs, at: at, count: count) }

    /// Programs overlapping [from, until), for the calendar/guide grids.
    public func programs(in range: Range<Millis>) -> [Program] {
        programs.filter { $0.endUtc > range.lowerBound && $0.startUtc < range.upperBound }
    }

    // MARK: test / recovery hooks

    /// Drop programs matching a predicate — used to simulate the aged-row sweep.
    public func debugRemovePrograms(_ predicate: (Program) -> Bool) {
        programs.removeAll(where: predicate)
    }

    /// Force `generated_thru` forward, to reproduce a stale-pointer hole.
    public func debugSetGeneratedThru(_ ts: Millis) { channel.generatedThru = ts }
}
