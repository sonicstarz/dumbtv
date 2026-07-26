import Foundation
import dumbTVCore

/// On-screen evidence for the build-10 tvOS failure investigation. There is no
/// Apple TV to debug on locally, so build 11 makes the app self-report: this is
/// populated during app init and by the embedded server, and surfaced on
/// channel 00 whenever the config server isn't reachable. One TestFlight
/// screenshot from a real device then says which hypothesis (store write
/// failure vs a main-thread hang vs a bind failure) is true.
///
/// Plain ObservableObject (not @MainActor) so `dumbTVApp.init` can populate it
/// synchronously; the server hops to main before touching it.
final class SystemDiagnostics: ObservableObject {
    @Published var storeOpened = false
    @Published var storeError: String?
    @Published var storePath = ""
    @Published var serverState = "not started"
    @Published var serverPort: UInt16 = 0
    @Published var configURL: String?

    var platform: String {
        #if os(tvOS)
        return "tvOS"
        #elseif os(iOS)
        return "iOS"
        #else
        return "macOS"
        #endif
    }
    var lanIP: String { NetworkInfo.primaryIPv4() ?? "—" }

    /// Set from the server's NWListener state callback (any queue → main).
    func setServerState(_ s: String) {
        if Thread.isMainThread { serverState = s }
        else { DispatchQueue.main.async { self.serverState = s } }
    }
}
