import XCTest
@testable import CathodeCore

final class ScheduleTests: XCTestCase {

    // A fake library: three shows of varying episode length.
    func makeShow(key: String, title: String, eps: Int, mins: Int) -> [Media] {
        var out: [Media] = []
        for i in 1...eps {
            let season: Int = (i - 1) / 13 + 1
            let ep: Int = (i - 1) % 13 + 1
            let aired: String = "199\((i % 9) + 1)-0\((i % 9) + 1)-1\(i % 9)"
            let dur: Millis = Millis(mins) * 60_000 + Millis(i % 7) * 1000
            let m = Media(ratingKey: "\(key)-e\(i)", parentKey: key, kind: .episode,
                          title: "Episode \(i)", showTitle: title,
                          seasonNo: season, episodeNo: ep, aired: aired,
                          durationMs: dur, partKey: "/library/parts/\(key)-\(i)/file.mkv")
            out.append(m)
        }
        return out
    }

    func makeBuckets() -> [[Media]] {
        [
            makeShow(key: "show-xmen", title: "X-Men Evolution", eps: 26, mins: 22),
            makeShow(key: "show-spidey", title: "Spider-Man", eps: 20, mins: 21),
            makeShow(key: "show-gargoyles", title: "Gargoyles", eps: 18, mins: 23),
        ]
    }

    let now: Millis = 1_700_000_000_000
    let window: Millis = 2 * 24 * 60 * 60 * 1000

    func testRNGDeterministic() {
        var a = Mulberry32(seed: 12345)
        var b = Mulberry32(seed: 12345)
        for _ in 0..<100 { XCTAssertEqual(a.next(), b.next()) }
        XCTAssertEqual(hashString("stagger:3:99"), hashString("stagger:3:99"))
    }

    func testNoGapsNoOverlaps() {
        let ch = ChannelSpec(id: 2, number: 2, name: "Retro", orderingMode: .sequential, shuffleSeed: 12347)
        let progs = Generator.generate(channel: ch, buckets: makeBuckets(), now: now, windowMs: window)
        XCTAssertFalse(progs.isEmpty)
        for i in 1..<progs.count {
            XCTAssertEqual(progs[i].startUtc, progs[i - 1].endUtc, "back-to-back, no gap/overlap")
        }
    }

    func testJoinInProgress() {
        let ch = ChannelSpec(id: 2, number: 2, name: "Retro", orderingMode: .sequential, shuffleSeed: 12347)
        let progs = Generator.generate(channel: ch, buckets: makeBuckets(), now: now, windowMs: window)
        let live = Resolver.nowOn(progs, at: now)
        XCTAssertNotNil(live)
        if let live {
            XCTAssertGreaterThanOrEqual(live.offsetMs, 0)
            XCTAssertLessThan(live.offsetMs, live.program.durationMs, "offset lands inside the program")
        }
        // always something on later, too
        for mins in [5, 37, 61, 143] {
            XCTAssertNotNil(Resolver.nowOn(progs, at: now + Millis(mins) * 60_000))
        }
    }

    func testSequentialRotates() {
        let ch = ChannelSpec(id: 2, number: 2, name: "Retro", orderingMode: .sequential, shuffleSeed: 12347)
        let progs = Generator.generate(channel: ch, buckets: makeBuckets(), now: now, windowMs: window)
        let firstThree = Set(progs.prefix(3).map { $0.title })
        XCTAssertEqual(firstThree.count, 3, "sequential rotates across the three shows")
    }

    func testStableShuffle() {
        let ch = ChannelSpec(id: 3, number: 3, name: "Shuffle", orderingMode: .shuffle, shuffleSeed: 999)
        let a = Generator.generate(channel: ch, buckets: makeBuckets(), now: now, windowMs: window)
        let b = Generator.generate(channel: ch, buckets: makeBuckets(), now: now, windowMs: window)
        XCTAssertEqual(a.map { $0.ratingKey }, b.map { $0.ratingKey }, "same seed → identical schedule")
    }

    func testStaggerDiffersAcrossChannels() {
        let buckets = makeBuckets()
        let c2 = Generator.generate(channel: ChannelSpec(id: 2, number: 2, name: "A", orderingMode: .sequential, shuffleSeed: 12347), buckets: buckets, now: now, windowMs: window)
        let c3 = Generator.generate(channel: ChannelSpec(id: 3, number: 3, name: "B", orderingMode: .sequential, shuffleSeed: 55555), buckets: buckets, now: now, windowMs: window)
        let s2 = Resolver.nowOn(c2, at: now)!.program.startUtc
        let s3 = Resolver.nowOn(c3, at: now)!.program.startUtc
        XCTAssertNotEqual(s2, s3, "channels are staggered, not in lock-step")
    }
}
