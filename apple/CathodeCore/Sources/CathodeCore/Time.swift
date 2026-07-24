import Foundation

/// Time helpers, ported from `src/util/time.js`. Everything is epoch
/// milliseconds (`Millis`), matching the Node engine's `Date.now()`.
///
/// Slot alignment is anchored to **local** midnight, not UTC, so slots land on
/// wall-clock :00/:30 even in half-hour-offset timezones. All the calendar math
/// here therefore runs against a `Calendar` in a concrete timezone — by default
/// the device's, exactly like `new Date(ts)` in Node.

public let MINUTE: Millis = 60_000
public let HOUR: Millis = 60 * MINUTE
public let DAY: Millis = 24 * HOUR
public let WEEK: Millis = 7 * DAY

/// A calendar bound to one timezone. The whole scheduler shares an instance so
/// "local midnight" means the same thing everywhere in a build. Tests can pin a
/// fixed zone for reproducibility; the app uses `.device`.
public struct Clock: Sendable {
    public var calendar: Calendar

    public init(timeZone: TimeZone = .current) {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        self.calendar = c
    }

    public static let device = Clock()

    private func date(_ ms: Millis) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000.0) }
    private func ms(_ d: Date) -> Millis { Millis((d.timeIntervalSince1970 * 1000).rounded()) }

    /// Epoch ms of local midnight for the day containing `ts`.
    public func localMidnight(_ ts: Millis) -> Millis {
        ms(calendar.startOfDay(for: date(ts)))
    }

    /// Round `ts` up to the next slot boundary, anchored to local midnight.
    /// Already-on-a-boundary stays put.
    public func ceilToSlot(_ ts: Millis, _ slotMinutes: Int) -> Millis {
        let slot = Millis(slotMinutes) * MINUTE
        let base = localMidnight(ts)
        let delta = ts - base
        let rounded = ((delta + slot - 1) / slot) * slot   // ceil for non-negative delta
        return base + (delta <= 0 ? (delta / slot) * slot : rounded)
    }

    /// 0 = Sunday … 6 = Saturday, matching JS `Date.getDay()`.
    public func dayOfWeek(_ ts: Millis) -> Int {
        calendar.component(.weekday, from: date(ts)) - 1
    }

    public func hour(_ ts: Millis) -> Int { calendar.component(.hour, from: date(ts)) }
    public func minute(_ ts: Millis) -> Int { calendar.component(.minute, from: date(ts)) }
    public func year(_ ts: Millis) -> Int { calendar.component(.year, from: date(ts)) }

    public func minutesIntoLocalDay(_ ts: Millis) -> Int {
        let c = calendar.dateComponents([.hour, .minute], from: date(ts))
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// The epoch ms of `h:m:00` on the local day that contains `ts`.
    public func atTime(_ ts: Millis, hour h: Int, minute m: Int) -> Millis {
        let day = calendar.startOfDay(for: date(ts))
        var comps = calendar.dateComponents([.year, .month, .day], from: day)
        comps.hour = h; comps.minute = m; comps.second = 0
        return ms(calendar.date(from: comps) ?? day)
    }

    /// Local `y-m-d h:m:00` → epoch ms. Month is 1-based here (unlike JS).
    public func makeLocal(year: Int, month: Int, day: Int, hour: Int, minute: Int) -> Millis {
        var comps = DateComponents()
        comps.year = year; comps.month = month; comps.day = day
        comps.hour = hour; comps.minute = minute; comps.second = 0
        return ms(calendar.date(from: comps) ?? Date(timeIntervalSince1970: 0))
    }

    public func addDays(_ ts: Millis, _ days: Int) -> Millis {
        ms(calendar.date(byAdding: .day, value: days, to: date(ts)) ?? date(ts))
    }
}

/// 'HH:MM' → minutes past local midnight, or nil on bad input.
public func parseClock(_ hhmm: String?) -> Int? {
    guard let hhmm else { return nil }
    let parts = hhmm.trimmingCharacters(in: .whitespaces).split(separator: ":")
    guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
          h <= 23, m <= 59 else { return nil }
    return h * 60 + m
}

/// 'HH:MM' → (hour, minute), tolerant, defaulting to 0:0.
public func splitClock(_ hhmm: String?, defaultHour: Int = 0, defaultMinute: Int = 0) -> (Int, Int) {
    guard let hhmm else { return (defaultHour, defaultMinute) }
    let parts = hhmm.split(separator: ":")
    let h = parts.count > 0 ? Int(parts[0]) ?? defaultHour : defaultHour
    let m = parts.count > 1 ? Int(parts[1]) ?? defaultMinute : defaultMinute
    return (h, m)
}

/// Is `ts` inside the dark window? Handles windows that wrap midnight
/// (e.g. 20:00 → 07:00).
public func inDarkWindow(_ ts: Millis, _ darkStart: String?, _ darkEnd: String?, clock: Clock = .device) -> Bool {
    guard let s = parseClock(darkStart), let e = parseClock(darkEnd), s != e else { return false }
    let now = clock.minutesIntoLocalDay(ts)
    return s < e ? (now >= s && now < e) : (now >= s || now < e)
}

/// Minutes between two 'HH:MM' clocks, wrapping past midnight.
public func minutesBetween(_ start: String, _ end: String) -> Int {
    let (sh, sm) = splitClock(start)
    let (eh, em) = splitClock(end)
    var mins = (eh * 60 + em) - (sh * 60 + sm)
    if mins <= 0 { mins += 24 * 60 }
    return mins
}
