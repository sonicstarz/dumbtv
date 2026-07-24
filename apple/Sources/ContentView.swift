import SwiftUI

struct ContentView: View {
    @StateObject private var engine = Engine()
    @StateObject private var store = ScheduleStore()

    var body: some View {
        TabView {
            TVView(engine: engine)
                .task { await engine.bootstrapFromEnvIfPresent() }
                .tabItem { Label("Watch", systemImage: "tv") }

            ScheduleView(store: store)
                .tabItem { Label("Schedule", systemImage: "calendar.badge.clock") }

            CalendarView(store: store)
                .tabItem { Label("Calendar", systemImage: "calendar") }
        }
    }
}

#Preview {
    ContentView()
}
