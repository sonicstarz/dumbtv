import SwiftUI

struct ContentView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 18) {
                Text("CATHODE")
                    .font(.system(size: 72, weight: .heavy))
                    .foregroundStyle(Palette.amber)
                    .tracking(6)
                Text("what's on is what's on")
                    .font(.system(.title3, design: .monospaced))
                    .foregroundStyle(Palette.dim)
            }
        }
    }
}

#Preview {
    ContentView()
}
