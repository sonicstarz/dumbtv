import Foundation

enum NetworkInfo {
    /// The primary non-loopback IPv4 address — for showing a reachable config
    /// URL on screen. Prefers Wi-Fi/en0; returns nil if only loopback is up.
    static func primaryIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        var fallback: String?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) == IFF_UP, (flags & IFF_LOOPBACK) == 0,
                  let sa = ptr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            let ip = String(cString: host)
            let name = String(cString: ptr.pointee.ifa_name)
            if name == "en0" { return ip }        // Wi-Fi / primary interface wins
            if fallback == nil { fallback = ip }
        }
        return fallback
    }

    /// The config URL to show/scan, e.g. "http://10.0.1.21:8080".
    static func configURL(port: UInt16) -> String {
        "http://\(primaryIPv4() ?? "localhost"):\(port)"
    }
}
