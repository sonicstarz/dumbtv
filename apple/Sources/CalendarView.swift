import SwiftUI
import dumbTVCore

/// The native week-grid Calendar — the counterpart of the web app's calendar
/// view. Every show on a channel, laid out across seven days exactly as it airs:
/// an hour gutter, one column per day, program blocks positioned by their real
/// start/length, a now-line on today, and off-air blocks greyed out.
struct CalendarView: View {
    @ObservedObject var store: ScheduleStore
    @State private var weekStart: Millis = 0
    @State private var channelId: Int?

    private let pxPerHour: CGFloat = 46
    private let dayWidth: CGFloat = 116
    private let gutterWidth: CGFloat = 40
    private var colHeight: CGFloat { pxPerHour * 24 }

    private var days: [Millis] { (0..<7).map { weekStart + Millis($0) * DAY } }
    private var cid: Int? { channelId ?? store.selectedChannelId }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                controls
                Divider()
                grid
            }
            .navigationTitle("Calendar")
            .onAppear {
                if weekStart == 0 { weekStart = store.clock.localMidnight(store.nowMs()) }
                if channelId == nil { channelId = store.selectedChannelId ?? store.channels.first?.id }
            }
        }
    }

    // MARK: controls

    private var controls: some View {
        VStack(spacing: 8) {
            Picker("Channel", selection: Binding(
                get: { cid ?? store.channels.first?.id ?? 0 },
                set: { channelId = $0 })) {
                ForEach(store.channels) { c in Text("\(c.number) · \(c.name)").tag(c.id) }
            }
            .pickerStyle(.menu)

            HStack {
                Button { weekStart -= 7 * DAY } label: { Image(systemName: "chevron.left") }
                Button("This week") { weekStart = store.clock.localMidnight(store.nowMs()) }
                Button { weekStart += 7 * DAY } label: { Image(systemName: "chevron.right") }
                Spacer()
                Text("\(Fmt.day(days.first ?? 0)) – \(Fmt.day(days.last ?? 0))")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
    }

    // MARK: grid

    private var grid: some View {
        let programs = store.programs(cid, in: weekStart..<(weekStart + 7 * DAY))
        let today = store.clock.localMidnight(store.nowMs())
        return ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                dayHeaderRow(today: today)
                HStack(alignment: .top, spacing: 0) {
                    hourGutter
                    ForEach(days, id: \.self) { dayStart in
                        dayColumn(dayStart: dayStart, today: today, programs: programs)
                    }
                }
            }
        }
        .background(
            LinearGradient(colors: [Color(Palette.prevue1), Color(Palette.prevue2)],
                           startPoint: .top, endPoint: .bottom)
        )
    }

    private func dayHeaderRow(today: Millis) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: gutterWidth, height: 40)
            ForEach(days, id: \.self) { d in
                let isToday = d == today
                VStack(spacing: 1) {
                    Text(weekdayShort(d)).font(.system(size: 11, design: .monospaced))
                    Text(monthDay(d)).font(.system(size: 12, weight: .bold))
                }
                .foregroundStyle(isToday ? Color(Palette.amber) : .white)
                .frame(width: dayWidth, height: 40)
                .background(isToday ? Color.white.opacity(0.08) : .clear)
            }
        }
    }

    private var hourGutter: some View {
        ZStack(alignment: .topLeading) {
            Color.clear.frame(width: gutterWidth, height: colHeight)
            ForEach(0..<24, id: \.self) { h in
                Text(hourLabel(h))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.55))
                    .frame(width: gutterWidth, alignment: .trailing)
                    .offset(y: CGFloat(h) * pxPerHour - 5)
            }
        }
    }

    private func dayColumn(dayStart: Millis, today: Millis, programs: [Program]) -> some View {
        let dayEnd = dayStart + DAY
        let segments = programs.compactMap { p -> (Program, CGFloat, CGFloat)? in
            guard p.endUtc > dayStart && p.startUtc < dayEnd else { return nil }
            let s = max(p.startUtc, dayStart), e = min(p.endUtc, dayEnd)
            let top = CGFloat(s - dayStart) / CGFloat(HOUR) * pxPerHour
            let height = max(14, CGFloat(e - s) / CGFloat(HOUR) * pxPerHour)
            return (p, top, height)
        }
        return ZStack(alignment: .topLeading) {
            Color.white.opacity(0.02).frame(width: dayWidth, height: colHeight)
            ForEach(0..<24, id: \.self) { h in
                Rectangle().fill(.white.opacity(0.06)).frame(width: dayWidth, height: 1)
                    .offset(y: CGFloat(h) * pxPerHour)
            }
            ForEach(segments, id: \.0.startUtc) { seg in
                CalBlock(program: seg.0, width: dayWidth - 3, height: seg.1 == 0 ? seg.2 : seg.2)
                    .offset(x: 1, y: seg.1)
            }
            if dayStart == today {
                let y = CGFloat(store.nowMs() - dayStart) / CGFloat(HOUR) * pxPerHour
                Rectangle().fill(Color(Palette.tally)).frame(width: dayWidth, height: 2).offset(y: y)
            }
        }
        .frame(width: dayWidth, height: colHeight)
        .overlay(Rectangle().stroke(.white.opacity(0.08), lineWidth: 0.5))
    }

    // MARK: date helpers

    private func weekdayShort(_ ms: Millis) -> String {
        let f = DateFormatter(); f.dateFormat = "EEE"
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
    private func monthDay(_ ms: Millis) -> String {
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = store.clock.calendar.timeZone
        let c = cal.dateComponents([.month, .day], from: d)
        return "\(c.month ?? 0)/\(c.day ?? 0)"
    }
    private func hourLabel(_ h: Int) -> String {
        h == 0 ? "12a" : h < 12 ? "\(h)a" : h == 12 ? "12p" : "\(h - 12)p"
    }
}

private struct CalBlock: View {
    let program: Program
    let width: CGFloat
    let height: CGFloat

    private var isOff: Bool { program.kind == .offair }
    private var seLabel: String {
        guard let s = program.seasonNo, let e = program.episodeNo else { return "" }
        return " S\(s)·E\(e)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(isOff ? (program.title.isEmpty ? "Off air" : program.title) : program.title)
                .font(.system(size: 11, weight: .semibold)).lineLimit(1)
                .foregroundStyle(isOff ? .white.opacity(0.5) : .white)
            if height > 26 && !isOff {
                Text("\(Fmt.time(program.startUtc))\(seLabel)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7)).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 5).padding(.vertical, 3)
        .frame(width: width, height: height, alignment: .topLeading)
        .background(isOff ? Color.black.opacity(0.35) : Color(Palette.prevue1))
        .overlay(alignment: .leading) {
            Rectangle().fill(isOff ? Color(Palette.dim) : Color(Palette.amber)).frame(width: 3)
        }
        .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}
