import Foundation

/// SQLite-backed persistence for a self-contained app, mirroring `src/db.js`.
/// This is the storage half of the embedded backend on Apple; the scheduler
/// (`ChannelScheduler`, `Generator`, …) stays pure and reads a `Library` this
/// assembles. Schema is created at the final v2 shape (no legacy migrations).
public final class Store {
    public let sql: SQLite

    public init(path: String) throws {
        sql = try SQLite(path: path)
        sql.exec(Self.schema)
    }

    private func nowMs() -> Millis { Millis(Date().timeIntervalSince1970 * 1000) }

    // MARK: - settings (key → string; JSON-encode richer values at the call site)

    public func setSetting(_ key: String, _ value: String?) {
        if let value {
            _ = try? sql.run(
                "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                [.text(key), .text(value)])
        } else {
            _ = try? sql.run("DELETE FROM settings WHERE key=?", [.text(key)])
        }
    }
    public func getSetting(_ key: String) -> String? {
        (try? sql.query("SELECT value FROM settings WHERE key=?", [.text(key)]))?.first?.text("value")
    }
    public func getInt(_ key: String, _ fallback: Int) -> Int { getSetting(key).flatMap { Int($0) } ?? fallback }

    // MARK: - channels

    public func allChannels() -> [ChannelConfig] {
        ((try? sql.query("SELECT * FROM channels ORDER BY number")) ?? []).map(Self.channel)
    }
    public func channel(_ id: Int) -> ChannelConfig? {
        ((try? sql.query("SELECT * FROM channels WHERE id=?", [.int(Int64(id))])) ?? []).first.map(Self.channel)
    }

    /// Insert a new channel (its `id` is ignored/assigned). Returns the new id.
    @discardableResult
    public func insertChannel(_ c: ChannelConfig) -> Int {
        let id = (try? sql.run("""
            INSERT INTO channels
              (number,name,slot_minutes,ordering_mode,marathon_size,cursor,shuffle_seed,
               dark_start,dark_end,ads_enabled,max_ads_per_break,ad_tags,timing_mode,
               ads_between,cooldown_days,overrun_policy,enabled,generated_thru,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, channelParams(c) + [.int(nowMs())])) ?? 0
        return Int(id)
    }

    /// Overwrite an existing channel row (full update).
    public func saveChannel(_ c: ChannelConfig) {
        _ = try? sql.run("""
            UPDATE channels SET
              number=?,name=?,slot_minutes=?,ordering_mode=?,marathon_size=?,cursor=?,shuffle_seed=?,
              dark_start=?,dark_end=?,ads_enabled=?,max_ads_per_break=?,ad_tags=?,timing_mode=?,
              ads_between=?,cooldown_days=?,overrun_policy=?,enabled=?,generated_thru=?
            WHERE id=?
            """, channelParams(c) + [.int(Int64(c.id))])
    }

    public func deleteChannel(_ id: Int) {
        _ = try? sql.run("DELETE FROM channels WHERE id=?", [.int(Int64(id))])
    }

    public func nextChannelNumber() -> Int {
        let m = (try? sql.query("SELECT MAX(number) n FROM channels"))?.first?.int("n") ?? 1
        return Int(m) + 1
    }

    // MARK: - channel sources

    public func sources(_ channelId: Int) -> [ChannelSource] {
        ((try? sql.query("SELECT * FROM channel_sources WHERE channel_id=? ORDER BY id", [.int(Int64(channelId))])) ?? [])
            .map { ChannelSource(id: Int($0.int("id") ?? 0), ratingKey: $0.text("rating_key") ?? "",
                                 sourceType: $0.text("source_type") ?? "show", title: $0.text("title")) }
    }
    @discardableResult
    public func addSource(_ channelId: Int, ratingKey: String, sourceType: String, title: String?) -> Int {
        Int((try? sql.run("""
            INSERT OR IGNORE INTO channel_sources(channel_id,rating_key,source_type,title)
            VALUES(?,?,?,?)
            """, [.int(Int64(channelId)), .text(ratingKey), .text(sourceType), title.map { .text($0) } ?? .null])) ?? 0)
    }
    public func deleteSource(_ id: Int, channelId: Int) {
        _ = try? sql.run("DELETE FROM channel_sources WHERE id=? AND channel_id=?",
                         [.int(Int64(id)), .int(Int64(channelId))])
    }

    // MARK: - schedule rules

    public func rules(_ channelId: Int) -> [ScheduleRule] {
        ((try? sql.query("SELECT * FROM schedule_rules WHERE channel_id=? ORDER BY priority DESC, id",
                         [.int(Int64(channelId))])) ?? []).map(Self.rule)
    }
    @discardableResult
    public func insertRule(_ r: ScheduleRule) -> Int {
        Int((try? sql.run("""
            INSERT INTO schedule_rules
              (channel_id,name,kind,priority,enabled,days_of_week,start_time,duration_min,
               starts_at_utc,source_type,rating_key,ordering_mode,cursor,effective_from,
               effective_to,airdate_mode,cadence_compress)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, ruleParams(r))) ?? 0)
    }
    public func saveRule(_ r: ScheduleRule) {
        _ = try? sql.run("""
            UPDATE schedule_rules SET
              name=?,kind=?,priority=?,enabled=?,days_of_week=?,start_time=?,duration_min=?,
              starts_at_utc=?,source_type=?,rating_key=?,ordering_mode=?,cursor=?,effective_from=?,
              effective_to=?,airdate_mode=?,cadence_compress=?
            WHERE id=?
            """, Array(ruleParams(r).dropFirst()) + [.int(Int64(r.id))])
    }
    public func deleteRule(_ id: Int) {
        _ = try? sql.run("DELETE FROM schedule_rules WHERE id=?", [.int(Int64(id))])
    }

    // MARK: - excludes

    public func excludes(_ channelId: Int) -> Set<String> {
        Set(((try? sql.query("SELECT rating_key FROM channel_excludes WHERE channel_id=?",
                             [.int(Int64(channelId))])) ?? []).compactMap { $0.text("rating_key") })
    }
    public func setExcludes(_ channelId: Int, _ keys: Set<String>) {
        try? sql.transaction {
            _ = try sql.run("DELETE FROM channel_excludes WHERE channel_id=?", [.int(Int64(channelId))])
            for k in keys {
                _ = try sql.run("INSERT OR IGNORE INTO channel_excludes(channel_id,rating_key) VALUES(?,?)",
                                [.int(Int64(channelId)), .text(k)])
            }
        }
    }

    // MARK: - media cache

    public func upsertMedia(_ items: [Media]) {
        try? sql.transaction {
            for m in items {
                _ = try sql.run("""
                    INSERT INTO media(rating_key,parent_key,kind,title,show_title,season_no,
                        episode_no,aired,duration_ms,part_key,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(rating_key) DO UPDATE SET
                        parent_key=excluded.parent_key,kind=excluded.kind,title=excluded.title,
                        show_title=excluded.show_title,season_no=excluded.season_no,
                        episode_no=excluded.episode_no,aired=excluded.aired,
                        duration_ms=excluded.duration_ms,part_key=excluded.part_key,
                        updated_at=excluded.updated_at
                    """, [
                        .text(m.ratingKey), m.parentKey.map { .text($0) } ?? .null, .text(m.kind.rawValue),
                        .text(m.title), m.showTitle.map { .text($0) } ?? .null,
                        m.seasonNo.map { .int(Int64($0)) } ?? .null, m.episodeNo.map { .int(Int64($0)) } ?? .null,
                        m.aired.map { .text($0) } ?? .null, .int(m.durationMs),
                        m.partKey.map { .text($0) } ?? .null, .int(nowMs())])
            }
        }
    }
    /// All media belonging to a source key (the show itself, or its episodes).
    public func media(forSource ratingKey: String) -> [Media] {
        ((try? sql.query("SELECT * FROM media WHERE parent_key=? OR rating_key=?",
                         [.text(ratingKey), .text(ratingKey)])) ?? []).map(Self.media)
    }

    // MARK: - assets

    public func assets() -> [Asset] {
        ((try? sql.query("SELECT * FROM assets ORDER BY kind,title")) ?? []).map(Self.asset)
    }

    // MARK: - airings

    public func airing(_ channelId: Int, _ ratingKey: String) -> AiringState {
        guard let r = ((try? sql.query("SELECT count,last_aired FROM airings WHERE channel_id=? AND rating_key=?",
                                       [.int(Int64(channelId)), .text(ratingKey)])) ?? []).first
        else { return AiringState() }
        return AiringState(count: r.intOr("count", 0), lastAired: r.int("last_aired"))
    }
    public func setAiring(_ channelId: Int, _ ratingKey: String, _ s: AiringState) {
        _ = try? sql.run("""
            INSERT INTO airings(channel_id,rating_key,count,last_aired) VALUES(?,?,?,?)
            ON CONFLICT(channel_id,rating_key) DO UPDATE SET count=excluded.count,last_aired=excluded.last_aired
            """, [.int(Int64(channelId)), .text(ratingKey), .int(Int64(s.count)),
                  s.lastAired.map { .int($0) } ?? .null])
    }

    // MARK: - Library assembly (what the scheduler reads)

    /// Build the `Library` the generator needs for a channel: its sources'
    /// media, the channel's excludes, and the ad/bumper assets.
    public func library(forChannel channelId: Int) -> Library {
        let srcs = sources(channelId)
        var byKey: [String: Media] = [:]
        for s in srcs {
            for m in media(forSource: s.ratingKey) { byKey[m.ratingKey] = m }
        }
        return Library(mediaByKey: byKey, sources: srcs,
                       excludes: excludes(channelId), assets: assets())
    }

    // MARK: - row → model mappers

    static func channel(_ r: Row) -> ChannelConfig {
        ChannelConfig(
            id: Int(r.int("id") ?? 0), number: r.intOr("number", 0), name: r.text("name") ?? "",
            slotMinutes: r.intOr("slot_minutes", 30),
            orderingMode: OrderingMode(rawValue: r.text("ordering_mode") ?? "") ?? .sequential,
            marathonSize: r.intOr("marathon_size", 3), cursor: r.intOr("cursor", 0),
            shuffleSeed: UInt32(truncatingIfNeeded: r.int("shuffle_seed") ?? 1),
            darkStart: r.text("dark_start"), darkEnd: r.text("dark_end"),
            adsEnabled: r.bool("ads_enabled"), maxAdsPerBreak: r.intOr("max_ads_per_break", 10),
            adTags: r.text("ad_tags") ?? "",
            timingMode: TimingMode(rawValue: r.text("timing_mode") ?? "") ?? .continuous,
            adsBetween: r.intOr("ads_between", 4), cooldownDays: r.intOr("cooldown_days", 0),
            overrunPolicy: OverrunPolicy(rawValue: r.text("overrun_policy") ?? "") ?? .protect,
            enabled: r.bool("enabled"), generatedThru: r.int("generated_thru") ?? 0)
    }

    static func rule(_ r: Row) -> ScheduleRule {
        ScheduleRule(
            id: Int(r.int("id") ?? 0), channelId: r.intOr("channel_id", 0), name: r.text("name"),
            kind: RuleKind(rawValue: r.text("kind") ?? "") ?? .rotation, priority: r.intOr("priority", 0),
            enabled: r.bool("enabled"), daysOfWeek: r.text("days_of_week"), startTime: r.text("start_time"),
            durationMin: r.int("duration_min").map(Int.init), startsAtUtc: r.int("starts_at_utc"),
            sourceType: r.text("source_type"), ratingKey: r.text("rating_key"),
            orderingMode: r.text("ordering_mode").flatMap(OrderingMode.init(rawValue:)), cursor: r.intOr("cursor", 0),
            effectiveFrom: r.text("effective_from"), effectiveTo: r.text("effective_to"),
            airdateMode: r.text("airdate_mode").flatMap(AirdateMode.init(rawValue:)),
            cadenceCompress: r.double("cadence_compress") ?? 1)
    }

    static func media(_ r: Row) -> Media {
        Media(ratingKey: r.text("rating_key") ?? "", parentKey: r.text("parent_key"),
              kind: MediaKind(rawValue: r.text("kind") ?? "") ?? .episode, title: r.text("title") ?? "",
              showTitle: r.text("show_title"), seasonNo: r.int("season_no").map(Int.init),
              episodeNo: r.int("episode_no").map(Int.init), aired: r.text("aired"),
              durationMs: r.int("duration_ms") ?? 0, partKey: r.text("part_key"))
    }

    static func asset(_ r: Row) -> Asset {
        Asset(id: Int(r.int("id") ?? 0), title: r.text("title") ?? "", kind: r.text("kind") ?? "ad",
              durationMs: r.int("duration_ms") ?? 0, tags: r.text("tags") ?? "",
              path: r.text("path") ?? "", partKey: r.text("part_key"))
    }

    // MARK: - model → params

    private func channelParams(_ c: ChannelConfig) -> [SQLite.Value] {
        [.int(Int64(c.number)), .text(c.name), .int(Int64(c.slotMinutes)), .text(c.orderingMode.rawValue),
         .int(Int64(c.marathonSize)), .int(Int64(c.cursor)), .int(Int64(c.shuffleSeed)),
         c.darkStart.map { .text($0) } ?? .null, c.darkEnd.map { .text($0) } ?? .null,
         .int(c.adsEnabled ? 1 : 0), .int(Int64(c.maxAdsPerBreak)), .text(c.adTags),
         .text(c.timingMode.rawValue), .int(Int64(c.adsBetween)), .int(Int64(c.cooldownDays)),
         .text(c.overrunPolicy.rawValue), .int(c.enabled ? 1 : 0), .int(c.generatedThru)]
    }

    private func ruleParams(_ r: ScheduleRule) -> [SQLite.Value] {
        [.int(Int64(r.channelId)), r.name.map { .text($0) } ?? .null, .text(r.kind.rawValue),
         .int(Int64(r.priority)), .int(r.enabled ? 1 : 0), r.daysOfWeek.map { .text($0) } ?? .null,
         r.startTime.map { .text($0) } ?? .null, r.durationMin.map { .int(Int64($0)) } ?? .null,
         r.startsAtUtc.map { .int($0) } ?? .null, r.sourceType.map { .text($0) } ?? .null,
         r.ratingKey.map { .text($0) } ?? .null, r.orderingMode.map { .text($0.rawValue) } ?? .null,
         .int(Int64(r.cursor)), r.effectiveFrom.map { .text($0) } ?? .null,
         r.effectiveTo.map { .text($0) } ?? .null, r.airdateMode.map { .text($0.rawValue) } ?? .null,
         .double(r.cadenceCompress)]
    }

    // MARK: - schema (final v2 shape, mirrors src/db.js)

    static let schema = """
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER UNIQUE NOT NULL, name TEXT NOT NULL,
      slot_minutes INTEGER NOT NULL DEFAULT 30, ordering_mode TEXT NOT NULL DEFAULT 'sequential',
      marathon_size INTEGER NOT NULL DEFAULT 3, cursor INTEGER NOT NULL DEFAULT 0,
      shuffle_seed INTEGER NOT NULL DEFAULT 1, dark_start TEXT, dark_end TEXT,
      ads_enabled INTEGER NOT NULL DEFAULT 1, max_ads_per_break INTEGER NOT NULL DEFAULT 10,
      ad_tags TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      generated_thru INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      cooldown_days INTEGER NOT NULL DEFAULT 0, timing_mode TEXT NOT NULL DEFAULT 'continuous',
      ads_between INTEGER NOT NULL DEFAULT 4, overrun_policy TEXT NOT NULL DEFAULT 'protect');

    CREATE TABLE IF NOT EXISTS channel_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      rating_key TEXT NOT NULL, source_type TEXT NOT NULL, title TEXT,
      weight INTEGER NOT NULL DEFAULT 1, UNIQUE(channel_id, rating_key));

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT, rating_key TEXT UNIQUE NOT NULL, parent_key TEXT,
      kind TEXT NOT NULL, title TEXT NOT NULL, show_title TEXT, season_no INTEGER, episode_no INTEGER,
      aired TEXT, duration_ms INTEGER NOT NULL, part_key TEXT, thumb TEXT, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_media_parent ON media(parent_key);

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      kind TEXT NOT NULL, duration_ms INTEGER NOT NULL, tags TEXT NOT NULL DEFAULT '',
      rating_key TEXT, part_key TEXT, gain_db REAL);

    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      start_utc INTEGER NOT NULL, end_utc INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      kind TEXT NOT NULL, rating_key TEXT, asset_id INTEGER, title TEXT NOT NULL, subtitle TEXT,
      season_no INTEGER, episode_no INTEGER, slot_start INTEGER NOT NULL,
      rule_id INTEGER, airing_no INTEGER DEFAULT 1);
    CREATE INDEX IF NOT EXISTS idx_programs_lookup ON programs(channel_id, start_utc, end_utc);

    CREATE TABLE IF NOT EXISTS schedule_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT, kind TEXT NOT NULL, priority INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      days_of_week TEXT, start_time TEXT, duration_min INTEGER, starts_at_utc INTEGER,
      source_type TEXT, rating_key TEXT, ordering_mode TEXT, cursor INTEGER NOT NULL DEFAULT 0,
      effective_from TEXT, effective_to TEXT, ad_policy TEXT, airdate_mode TEXT,
      cadence_compress REAL NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS idx_rules_channel ON schedule_rules(channel_id, priority DESC);

    CREATE TABLE IF NOT EXISTS airings (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      rating_key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_aired INTEGER,
      PRIMARY KEY (channel_id, rating_key));

    CREATE TABLE IF NOT EXISTS channel_excludes (
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      rating_key TEXT NOT NULL, PRIMARY KEY (channel_id, rating_key));
    """
}
