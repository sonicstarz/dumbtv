import Foundation

/// Store-backed schedule coordinator — the piece that was missing. It drives
/// `RuleScheduler` and **persists** its output to the `programs` table, so the
/// schedule is append-only and survives restarts (invariant #4). Everything
/// that shows "what's on" — the player, the guide, on-air — then reads the same
/// persisted rows, so they always agree.
///
/// This mirrors `ChannelScheduler.generateChannel/regenerateChannel`, but with
/// SQLite as the source of truth instead of an in-memory array. It is the Swift
/// counterpart of the Node engine's hourly top-up + `regenerateChannel`.
public enum Scheduler {
    public static let defaultWindowDays = 14

    /// Extend every enabled channel forward to `now + windowDays`. Idempotent and
    /// cheap when already covered (a channel whose `generated_thru` is past the
    /// horizon does no work). Run at boot and hourly.
    public static func topUp(store: Store, now: Millis,
                             windowDays: Int = defaultWindowDays, clock: Clock = .device) {
        let until = now + Millis(windowDays) * DAY
        for var c in store.allChannels() where c.enabled {
            generate(store: store, channel: &c, now: now, until: until, clock: clock)
        }
    }

    /// Make sure one channel has something scheduled at `now`, generating only if
    /// there's a hole. Used by read endpoints so a brand-new channel (created via
    /// the web UI a moment ago) shows content without waiting for the next top-up.
    public static func ensureCoverage(store: Store, channelId: Int, now: Millis,
                                      windowDays: Int = defaultWindowDays, clock: Clock = .device) {
        guard var c = store.channel(channelId), c.enabled else { return }
        if store.hasProgramAt(c.id, now) && c.generatedThru >= now { return }
        generate(store: store, channel: &c, now: now, until: now + Millis(windowDays) * DAY, clock: clock)
    }

    /// Throw away everything not yet aired and rebuild the future from the leading
    /// edge — what to call after a config change (added a show, edited ordering).
    /// Whatever is airing right now is preserved (invariant #4).
    public static func regenerate(store: Store, channelId: Int, now: Millis,
                                  windowDays: Int = defaultWindowDays, clock: Clock = .device) {
        guard var c = store.channel(channelId) else { return }
        store.deleteProgramsFrom(c.id, now)                 // drop the future
        store.deletePlaceholderAiring(c.id, now)            // …and any airing "no content" span
        c.generatedThru = store.lastProgramEndBefore(c.id, now) ?? now
        store.saveChannel(c)
        generate(store: store, channel: &c, now: now, until: now + Millis(windowDays) * DAY, clock: clock)
    }

    /// Rebuild the future of every channel — after an import, or a global setting.
    public static func regenerateAll(store: Store, now: Millis,
                                     windowDays: Int = defaultWindowDays, clock: Clock = .device) {
        for c in store.allChannels() {
            regenerate(store: store, channelId: c.id, now: now, windowDays: windowDays, clock: clock)
        }
    }

    // MARK: - core

    /// Extend one channel forward to `until`, append-only. If nothing is airing
    /// at `now` (a hole), stray future rows are dropped and it rebuilds from the
    /// leading edge — the same recovery `ChannelScheduler` does.
    @discardableResult
    static func generate(store: Store, channel c: inout ChannelConfig,
                         now: Millis, until: Millis, clock: Clock) -> Int {
        let rules = effectiveRules(c, store.rules(c.id))
        let library = store.library(forChannel: c.id)
        let airings = store.airings(c.id)

        var from: Millis
        if let onNow = store.programEndIfAiring(c.id, at: now) {
            from = c.generatedThru > now ? c.generatedThru : onNow
        } else {
            store.deleteProgramsFrom(c.id, now)
            from = now - RuleScheduler.staggerOffset(c)
        }
        guard from < until else { return 0 }

        let built = RuleScheduler.buildChannelPrograms(
            channel: c, rules: rules, library: library, airings: airings,
            from: from, until: until, clock: clock)

        store.insertPrograms(built.rows)
        c.cursor = built.cursor
        c.generatedThru = built.through
        store.saveChannel(c)

        for (rk, n) in built.airingBump {
            let lastEnd = built.rows.filter { $0.ratingKey == rk }.map { $0.endUtc }.max() ?? 0
            var st = store.airing(c.id, rk)
            st.count += n
            st.lastAired = max(st.lastAired ?? 0, lastEnd)
            store.setAiring(c.id, rk, st)
        }
        return built.rows.count
    }

    /// Synthesize a channel's default rules when it has none persisted: a
    /// rotation rule from its ordering, plus a blackout from any dark hours.
    /// Mirrors `ChannelScheduler.ensureChannelRules`.
    static func effectiveRules(_ c: ChannelConfig, _ persisted: [ScheduleRule]) -> [ScheduleRule] {
        guard persisted.isEmpty else { return persisted }
        var out = [ScheduleRule(id: -1, channelId: c.id, name: "Everything else",
                                kind: .rotation, priority: 0, orderingMode: c.orderingMode, cursor: c.cursor)]
        if let ds = c.darkStart, let de = c.darkEnd {
            out.append(ScheduleRule(id: -2, channelId: c.id, name: "Off air", kind: .blackout,
                                    priority: 1000, daysOfWeek: "0,1,2,3,4,5,6",
                                    startTime: ds, durationMin: minutesBetween(ds, de)))
        }
        return out
    }
}
