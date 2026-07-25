import Foundation
import CryptoKit

/// One household PIN, not a user system — the Swift port of `src/auth.js`.
/// It gates mutations (channel edits, rules, settings, player control); the TV
/// and read-only endpoints stay open. Sessions are a stateless HMAC cookie so
/// they survive restarts; rotating the secret (new PIN or logout) invalidates
/// them. Storage: `pin_hash` ("salt:hash") + `auth_secret` in settings.
enum Auth {
    static func isConfigured(_ store: Store) -> Bool {
        store.getSetting("pin_hash") != nil
    }

    private static func hash(_ pin: String, salt: String) -> String {
        // SHA-256(salt:pin) — plenty for a 4–6 digit household PIN gating a LAN
        // config page (not password storage; there's nothing to exfiltrate).
        let digest = SHA256.hash(data: Data("\(salt):\(pin)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func randomHex(_ bytes: Int) -> String {
        (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    static func setPin(_ store: Store, pin: String) {
        let salt = randomHex(16)
        store.setSetting("pin_hash", "\(salt):\(hash(pin, salt: salt))")
        store.setSetting("auth_secret", randomHex(32))   // invalidate old sessions
    }

    static func verifyPin(_ store: Store, pin: String) -> Bool {
        guard let stored = store.getSetting("pin_hash") else { return false }
        let parts = stored.split(separator: ":").map(String.init)
        guard parts.count == 2 else { return false }
        // Constant-time compare, same intent as Node's timingSafeEqual.
        let test = hash(pin, salt: parts[0])
        guard test.count == parts[1].count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(test.utf8, parts[1].utf8) { diff |= a ^ b }
        return diff == 0
    }

    private static func secret(_ store: Store) -> String {
        if let s = store.getSetting("auth_secret") { return s }
        let s = randomHex(32)
        store.setSetting("auth_secret", s)
        return s
    }

    static func sessionToken(_ store: Store) -> String {
        let key = SymmetricKey(data: Data(secret(store).utf8))
        let mac = HMAC<SHA256>.authenticationCode(for: Data("ok".utf8), using: key)
        return mac.map { String(format: "%02x", $0) }.joined()
    }

    static func tokenValid(_ store: Store, token: String?) -> Bool {
        guard let token else { return false }
        let want = sessionToken(store)
        guard token.count == want.count else { return false }
        var diff: UInt8 = 0
        for (a, b) in zip(token.utf8, want.utf8) { diff |= a ^ b }
        return diff == 0
    }

    /// Pull the session token out of a raw Cookie header.
    static func cookieToken(_ cookieHeader: String?) -> String? {
        guard let cookieHeader else { return nil }
        for part in cookieHeader.split(separator: ";") {
            let kv = part.trimmingCharacters(in: .whitespaces)
            if kv.hasPrefix("dumbtv_auth=") {
                return String(kv.dropFirst("dumbtv_auth=".count)).removingPercentEncoding
                    ?? String(kv.dropFirst("dumbtv_auth=".count))
            }
        }
        return nil
    }

    static func sessionCookieHeader(_ store: Store) -> String {
        "dumbtv_auth=\(sessionToken(store)); Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
    }

    static func logout(_ store: Store) {
        store.setSetting("auth_secret", randomHex(32))   // rotate → all sessions die
    }
}
