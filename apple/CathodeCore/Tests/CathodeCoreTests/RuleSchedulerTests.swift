import XCTest
@testable import CathodeCore

/// Mirrors the invariants in `scripts/selftest.js` against the ported v2
/// reservation scheduler: no gaps, no overlaps, join-in-progress, ordering
/// modes, stable shuffle across a top-up, dark hours, ad caps, reservations
/// (pinned/conflict/airdate/cadence/cut-in), cooldown, exclusions, empty-channel
/// recovery, and the hole backfill.
final class RuleSchedulerTests: XCTestCase {

    // A fixed clock + instant so every run is identical, regardless of the host TZ.
    let clock = Clock(timeZone: TimeZone(identifier: "America/New_York")!)
    let now: Millis = 1_700_000_000_000        // 2023-11-14T22:13:20Z
    let twoDays: Millis = 2 * 24 * HOUR

    // MARK: fixtures

    func makeShow(_ key: String, _ title: String, eps: Int, mins: Int) -> [Media] {
        (1...eps).map { i in
            let season = (i - 1) / 13 + 1
            let ep = (i - 1) % 13 + 1
            let aired = "199\((i % 9) + 1)-0\((i % 9) + 1)-1\(i % 9)"
            let dur = Millis(mins) * 60_000 + Millis(i % 7) * 1000
            return Media(ratingKey: "\(key)-e\(i)", parentKey: key, kind: .episode,
                         title: "Episode \(i)", showTitle: title, seasonNo: season,
                         episodeNo: ep, aired: aired, durationMs: dur,
                         partKey: "/library/parts/\(key)-\(i)/file.mkv")
        }
    }

    var showMedia: [Media] {
        makeShow("show-xmen", "X-Men Evolution", eps: 26, mins: 22)
            + makeShow("show-spidey", "Spider-Man", eps: 20, mins: 21)
            + makeShow("show-gargoyles", "Gargoyles", eps: 18, mins: 23)
    }

    var movieMedia: [Media] {
        (1...6).map { i in
            Media(ratingKey: "movie-\(i)", parentKey: nil, kind: .movie, title: "Kids Movie \(i)",
                  showTitle: nil, seasonNo: nil, episodeNo: nil, aired: "199\(i)-01-01",
                  durationMs: Millis(78 + i * 4) * 60_000, partKey: "/library/parts/movie-\(i)/file.mkv")
        }
    }

    var assets: [Asset] {
        var a: [Asset] = []
        for (i, s) in [15, 30, 30, 45, 60, 20].enumerated() {
            a.append(Asset(id: i + 1, title: "Toy Ad \(i)", kind: "ad", durationMs: Millis(s) * 1000, tags: "90s,toys"))
        }
        for (i, s) in [5, 8, 10].enumerated() {
            a.append(Asset(id: 100 + i, title: "Station ID \(i)", kind: "bumper", durationMs: Millis(s) * 1000))
        }
        return a
    }

    func makeChannel(_ number: Int, _ name: String, _ mode: OrderingMode,
                     dark: (String, String)? = nil, cooldown: Int = 0,
                     overrun: OverrunPolicy = .protect, timing: TimingMode = .continuous,
                     adsBetween: Int = 4) -> ChannelConfig {
        ChannelConfig(id: number, number: number, name: name, slotMinutes: 30, orderingMode: mode,
                      marathonSize: 3, cursor: 0, shuffleSeed: UInt32(12345 + number),
                      darkStart: dark?.0, darkEnd: dark?.1, adsEnabled: true, maxAdsPerBreak: 4,
                      adTags: "", timingMode: timing, adsBetween: adsBetween, cooldownDays: cooldown,
                      overrunPolicy: overrun)
    }

    func showLibrary(sourceKeys: [String]) -> Library {
        let srcs = sourceKeys.enumerated().map { i, k in
            ChannelSource(id: i + 1, ratingKey: k, sourceType: k.hasPrefix("movie") ? "movie" : "show", title: k)
        }
        return Library(media: showMedia + movieMedia, sources: srcs, assets: assets)
    }

    func sched(_ channel: ChannelConfig, sources: [String]) -> ChannelScheduler {
        ChannelScheduler(channel: channel, library: showLibrary(sourceKeys: sources), clock: clock)
    }

    // MARK: integrity

    func testNoGapsNoOverlaps() {
        for mode in [OrderingMode.sequential, .shuffle, .release_order, .marathon] {
            let s = sched(makeChannel(2, "Ch", mode), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
            s.generateChannel(now: now, until: now + twoDays)
            let rows = s.programs.sorted { $0.startUtc < $1.startUtc }
            XCTAssertFalse(rows.isEmpty, "\(mode) produced no programs")
            for i in 1..<rows.count {
                XCTAssertEqual(rows[i].startUtc, rows[i - 1].endUtc, "\(mode): gap/overlap at \(i)")
            }
        }
    }

    func testBlocksRunBackToBackNotOnGrid() {
        let s = sched(makeChannel(2, "Retro", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let slots = Set(s.programs.filter { $0.kind == .episode || $0.kind == .movie }.map { $0.slotStart }).sorted().prefix(30)
        let offGrid = slots.filter { clock.minute($0) % 30 != 0 }.count
        XCTAssertGreaterThan(offGrid, 0, "blocks should run back-to-back, not on a 30-min grid")
    }

    func testChannelsStaggered() {
        let a = sched(makeChannel(2, "A", .sequential), sources: ["show-xmen", "show-spidey"])
        let b = sched(makeChannel(3, "B", .sequential), sources: ["show-xmen", "show-spidey"])
        a.generateChannel(now: now, until: now + twoDays)
        b.generateChannel(now: now, until: now + twoDays)
        XCTAssertNotEqual(a.nowOn(at: now)?.program.startUtc, b.nowOn(at: now)?.program.startUtc)
    }

    func testJoinInProgress() {
        let s = sched(makeChannel(2, "Retro", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let live = s.nowOn(at: now)
        XCTAssertNotNil(live)
        if let live {
            XCTAssertGreaterThanOrEqual(live.offsetMs, 0)
            XCTAssertLessThan(live.offsetMs, live.program.durationMs + 1000)
        }
        for mins in [5, 37, 61, 143] {
            XCTAssertNotNil(s.nowOn(at: now + Millis(mins) * MINUTE), "nothing on at +\(mins)m")
        }
    }

    // MARK: ordering

    func testSequentialRotates() {
        let s = sched(makeChannel(2, "Retro", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let titles = s.programs.filter { $0.kind == .episode }.prefix(3).map { $0.title }
        XCTAssertEqual(Set(titles).count, 3, "sequential rotates across the three shows")
    }

    func testReleaseOrderChronological() {
        let s = sched(makeChannel(4, "Movies", .release_order),
                      sources: ["movie-1", "movie-2", "movie-3", "movie-4", "movie-5", "movie-6"])
        s.generateChannel(now: now, until: now + twoDays)
        let byKey = Dictionary(uniqueKeysWithValues: (movieMedia).map { ($0.ratingKey, $0.aired ?? "") })
        let aired = s.programs.filter { $0.kind == .movie }.prefix(6).compactMap { $0.ratingKey.flatMap { byKey[$0] } }
        for i in 1..<aired.count { XCTAssertGreaterThanOrEqual(aired[i], aired[i - 1]) }
    }

    func testStableShuffleAcrossTopUp() {
        let s = sched(makeChannel(3, "Shuffle", .shuffle), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        func future() -> [String] {
            s.programs.filter { $0.startUtc > now + 4 * HOUR && $0.kind == .episode }
                .prefix(10).compactMap { $0.ratingKey }
        }
        let before = future()
        s.generateChannel(now: now, until: now + twoDays)   // a top-up
        XCTAssertEqual(before, future(), "a top-up never moves an already-published program")
    }

    // MARK: dark hours

    func testDarkHours() {
        let s = sched(makeChannel(5, "Bedtime", .marathon, dark: ("20:00", "07:00")),
                      sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        XCTAssertFalse(s.programs.filter { $0.kind == .offair }.isEmpty, "bedtime channel goes off air")
        let leaked = s.programs.filter { $0.kind == .episode && inDarkWindow($0.startUtc, "20:00", "07:00", clock: clock) }
        XCTAssertTrue(leaked.isEmpty, "nothing airs during dark hours (\(leaked.count) leaked)")
    }

    // MARK: ad breaks

    func testAdCaps() {
        let s = sched(makeChannel(2, "Retro", .sequential, adsBetween: 4), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let ads = s.programs.filter { $0.kind == .ad }
        XCTAssertGreaterThan(ads.count, 0, "ads got scheduled")
        let perBreak = Dictionary(grouping: ads, by: { $0.slotStart }).mapValues { $0.count }
        XCTAssertLessThanOrEqual(perBreak.values.max() ?? 0, 4, "never more than 4 ads in a break")
    }

    // MARK: reservations

    func testPinnedStartsToTheMillisecond() {
        let s = sched(makeChannel(6, "Rules", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let pinnedAt = now + 6 * HOUR
        s.addRule(ScheduleRule(id: 0, channelId: 6, name: "Spidey Special", kind: .pinned,
                               priority: 800, startsAtUtc: pinnedAt, sourceType: "episode", ratingKey: "show-spidey-e3"))
        s.regenerateChannel(now: now)
        let pinned = s.programs.first { $0.ratingKey == "show-spidey-e3" && $0.startUtc == pinnedAt }
        XCTAssertNotNil(pinned, "a pinned program starts to the millisecond")
    }

    func testConflictsReported() {
        let s = sched(makeChannel(6, "Rules", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let at = now + 6 * HOUR
        s.addRule(ScheduleRule(id: 0, channelId: 6, name: "Spidey Special", kind: .pinned, priority: 800,
                               startsAtUtc: at, sourceType: "episode", ratingKey: "show-spidey-e3"))
        s.addRule(ScheduleRule(id: 0, channelId: 6, name: "Clashing Event", kind: .pinned, priority: 700,
                               startsAtUtc: at + 60_000, sourceType: "episode", ratingKey: "show-gargoyles-e2"))
        let regen = s.regenerateChannel(now: now)
        XCTAssertTrue(regen.conflicts.contains { $0.rule == "Clashing Event" }, "conflicts reported, never silently dropped")
        let rows = s.programs.sorted { $0.startUtc < $1.startUtc }
        for i in 1..<rows.count { XCTAssertEqual(rows[i].startUtc, rows[i - 1].endUtc, "no gap/overlap once reservations placed") }
    }

    func testAiringNoPremiere() {
        let s = sched(makeChannel(2, "Retro", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + twoDays)
        let minAiring = s.programs.filter { $0.kind == .episode }.map { $0.airingNo }.min()
        XCTAssertEqual(minAiring, 1, "premiere/rerun tracked (airing_no starts at 1)")
    }

    func testCooldownAiringUniqueBeforeRepeat() {
        let s = sched(makeChannel(7, "Cooldown", .shuffle, cooldown: 7), sources: ["show-xmen"])
        s.generateChannel(now: now, until: now + 7 * HOUR)
        let keys = s.programs.filter { $0.kind == .episode }.compactMap { $0.ratingKey }
        XCTAssertEqual(keys.count, Set(keys).count, "cooldown airs everything once before repeating (\(keys.count) aired, \(Set(keys).count) unique)")
    }

    // MARK: airdate

    func airdateLibrary() -> Library {
        // 12 episodes that originally aired on consecutive Saturdays from 1994-09-03.
        let satBase = clock.makeLocal(year: 1994, month: 9, day: 3, hour: 0, minute: 0)
        var eps: [Media] = []
        for i in 1...12 {
            let ts = satBase + Millis(i - 1) * WEEK
            let iso = isoDate(ts)
            eps.append(Media(ratingKey: "airdate-e\(i)", parentKey: "airdate-show", kind: .episode,
                             title: "AD Ep \(i)", showTitle: "Airdate Show", seasonNo: 1, episodeNo: i,
                             aired: iso, durationMs: 22 * 60_000, partKey: "/library/parts/ad-\(i)/file.mkv"))
        }
        let src = ChannelSource(id: 1, ratingKey: "airdate-show", sourceType: "show", title: "Airdate Show")
        return Library(media: eps, sources: [src], assets: assets)
    }

    func isoDate(_ ts: Millis) -> String {
        let d = Date(timeIntervalSince1970: Double(ts) / 1000)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/New_York")!
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    func testAirdateOriginalWeekday() {
        let s = ChannelScheduler(channel: makeChannel(8, "Airdate", .sequential), library: airdateLibrary(), clock: clock)
        s.generateChannel(now: now, until: now + twoDays)
        s.addRule(ScheduleRule(id: 0, channelId: 8, name: "Saturday Mornings", kind: .airdate, priority: 500,
                               startTime: "08:00", sourceType: "show", ratingKey: "airdate-show",
                               airdateMode: .original_weekday))
        s.regenerateChannel(now: now)
        let ruleId = s.rules.first { $0.kind == .airdate }!.id
        let placed = s.programs.filter { $0.ruleId == ruleId && $0.kind == .episode }
        XCTAssertFalse(placed.isEmpty, "airdate rule placed episodes")
        for p in placed {
            XCTAssertEqual(clock.dayOfWeek(p.startUtc), 6, "airs on Saturday")
            XCTAssertEqual(clock.hour(p.startUtc), 8, "at 08:00")
        }
        if placed.count >= 2 {
            let sorted = placed.sorted { $0.startUtc < $1.startUtc }
            XCTAssertNotEqual(sorted[0].ratingKey, sorted[1].ratingKey, "consecutive weeks advance through the show")
        }
    }

    func testOriginalCadenceCompressed() {
        let s = ChannelScheduler(channel: makeChannel(12, "Cadence", .sequential), library: airdateLibrary(), clock: clock)
        s.generateChannel(now: now, until: now + twoDays)
        s.addRule(ScheduleRule(id: 0, channelId: 12, name: "Cadence run", kind: .airdate, priority: 500,
                               startTime: "08:00", sourceType: "show", ratingKey: "airdate-show",
                               airdateMode: .original_cadence, cadenceCompress: 7))
        s.regenerateChannel(now: now)
        let ruleId = s.rules.first { $0.kind == .airdate }!.id
        let placed = s.programs.filter { $0.ruleId == ruleId && $0.kind == .episode }.sorted { $0.startUtc < $1.startUtc }
        XCTAssertGreaterThanOrEqual(placed.count, 2)
        let spanDays = Double(placed.last!.startUtc - placed.first!.startUtc) / Double(DAY)
        XCTAssertTrue(spanDays > 7 && spanDays < 14, "replays 77 original days ÷ 7 ≈ 11d (got \(spanDays))")
    }

    // MARK: overrun

    func testCutInHardCuts() {
        let s = sched(makeChannel(11, "CutIn", .sequential, overrun: .cutin), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        let pinAt = now + 5 * HOUR
        s.addRule(ScheduleRule(id: 0, channelId: 11, name: "Breaking Special", kind: .pinned, priority: 800,
                               startsAtUtc: pinAt, sourceType: "episode", ratingKey: "show-spidey-e5"))
        s.regenerateChannel(now: now)
        let media = Dictionary(uniqueKeysWithValues: showMedia.map { ($0.ratingKey, $0.durationMs) })
        let cut = s.programs.first { p in
            p.kind == .episode && p.endUtc == pinAt && p.ratingKey.flatMap { media[$0] }.map { p.durationMs < $0 } == true
        }
        XCTAssertNotNil(cut, "a show is hard-cut at the pinned start")
        // And the pinned episode airs exactly at its start.
        XCTAssertTrue(s.programs.contains { $0.ratingKey == "show-spidey-e5" && $0.startUtc == pinAt })
    }

    // MARK: exclusions

    func testExcludedNeverAirs() {
        let banned: Set<String> = ["show-xmen-e3", "show-xmen-e7", "show-xmen-e11"]
        var lib = Library(media: showMedia + movieMedia,
                          sources: [ChannelSource(id: 1, ratingKey: "show-xmen", sourceType: "show", title: "X-Men")],
                          assets: assets)
        lib.excludes = banned
        let s = ChannelScheduler(channel: makeChannel(14, "Filtered", .sequential), library: lib, clock: clock)
        s.generateChannel(now: now, until: now + twoDays)
        let airedBanned = s.programs.filter { $0.ratingKey.map { banned.contains($0) } == true }.count
        let airedOther = s.programs.filter { $0.kind == .episode }.count
        XCTAssertEqual(airedBanned, 0, "excluded episodes never air")
        XCTAssertGreaterThan(airedOther, 0, "other episodes still air")
    }

    // MARK: recovery

    func testEmptyChannelRecovers() {
        // Built with no sources → a "No content selected" placeholder.
        let s = ChannelScheduler(channel: makeChannel(13, "Added Later", .sequential),
                                 library: Library(media: showMedia + movieMedia, sources: [], assets: assets), clock: clock)
        s.generateChannel(now: now, until: now + twoDays)
        XCTAssertEqual(s.nowOn(at: now)?.program.title, "No content selected")
        // Content arrives.
        s.library.sources = ["show-xmen", "show-spidey", "show-gargoyles"].enumerated().map { i, k in
            ChannelSource(id: i + 1, ratingKey: k, sourceType: "show", title: k)
        }
        s.regenerateChannel(now: now)
        let title = s.nowOn(at: now)?.program.title
        XCTAssertNotNil(title)
        XCTAssertNotEqual(title, "No content selected", "empty channel recovers when content is added later")
    }

    func testHoleBackfilled() {
        let s = sched(makeChannel(15, "Hole", .sequential), sources: ["show-xmen", "show-spidey", "show-gargoyles"])
        s.generateChannel(now: now, until: now + 3 * DAY)
        // Simulate the sweep: wipe everything around now, but leave generated_thru far ahead.
        s.debugRemovePrograms { $0.endUtc > now - HOUR }
        s.debugSetGeneratedThru(now + 3 * DAY)
        let before = s.nowOn(at: now)
        s.generateChannel(now: now, until: now + 3 * DAY)   // the hourly top-up
        let after = s.nowOn(at: now)
        XCTAssertTrue(before == nil || before?.program.kind == .offair)
        XCTAssertEqual(after?.program.kind, .episode, "a schedule gap at now is backfilled, not skipped")
    }
}
