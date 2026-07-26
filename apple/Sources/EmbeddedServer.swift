import Foundation
import Network
import dumbTVCore

/// A tiny, dependency-free HTTP/1.1 server on Network.framework. It is the
/// transport for the on-device config backend: it parses requests, dispatches
/// `/api/*` to `ConfigAPI` (backed by the shared `Store`), and serves the web
/// config UI for everything else. You reach it from a phone/laptop browser on
/// the LAN — the same web UI every dumbTV device serves.
final class EmbeddedServer {
    private let api: ConfigAPI
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "dumbtv.httpd", attributes: .concurrent)
    let port: UInt16
    /// Reports NWListener lifecycle ("listening"/"failed: …") for on-screen
    /// diagnostics — surfaces a bind failure that print() alone would hide on a TV.
    var onStateChange: ((String) -> Void)?

    init(store: Store, port: UInt16 = 8080) {
        self.api = ConfigAPI(store: store)
        self.port = port
    }

    func start() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            listener?.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:            self?.onStateChange?("listening on \(self?.port ?? 0)")
                case .failed(let e):    self?.onStateChange?("failed: \(e)")
                case .waiting(let e):   self?.onStateChange?("waiting: \(e)")
                case .cancelled:        self?.onStateChange?("cancelled")
                default: break
                }
            }
            listener?.newConnectionHandler = { [weak self] conn in
                conn.start(queue: self?.queue ?? .global())
                self?.receive(conn, buffer: Data())
            }
            listener?.start(queue: queue)
            print("dumbTV config server on http://localhost:\(port)")
        } catch {
            onStateChange?("start threw: \(error)")
            print("dumbTV config server failed to start on \(port): \(error)")
        }
    }

    func stop() { listener?.cancel(); listener = nil }

    // MARK: - read a full request, then respond

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }

            if let req = HTTPRequest(buf) {
                self.respond(conn, to: req)
            } else if isComplete || error != nil {
                conn.cancel()
            } else if buf.count > 4_000_000 {
                // Cap an unbounded/never-completing request (a config POST is a
                // few KB; 4 MB is generous). Prevents runaway buffer growth.
                conn.cancel()
            } else {
                self.receive(conn, buffer: buf)   // headers or body still incomplete
            }
        }
    }

    private func respond(_ conn: NWConnection, to req: HTTPRequest) {
        Task {
            let (status, contentType, body, setCookie) = await self.buildResponse(req)
            var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
            head += "Content-Type: \(contentType)\r\n"
            head += "Content-Length: \(body.count)\r\n"
            if let setCookie { head += "Set-Cookie: \(setCookie)\r\n" }
            head += "Access-Control-Allow-Origin: *\r\n"
            head += "Connection: close\r\n\r\n"
            var out = Data(head.utf8); out.append(body)
            conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    private func buildResponse(_ req: HTTPRequest) async -> (Int, String, Data, String?) {
        // Poster proxy — returns raw image bytes (not JSON) so the browser can
        // <img src> Plex artwork without ever seeing the token.
        if req.path == "/api/image", let p = req.query["path"] {
            if let (data, ct) = await api.fetchImage(path: p) { return (200, ct, data, nil) }
            return (404, "text/plain", Data("no image".utf8), nil)
        }
        if req.path.hasPrefix("/api/") {
            let jsonBody = req.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let apiReq = ConfigAPI.Request(method: req.method, path: req.path, query: req.query,
                                           body: jsonBody, cookie: req.headers["cookie"])
            let r = await api.handle(apiReq)
            let data = (try? JSONSerialization.data(withJSONObject: r.json)) ?? Data("{}".utf8)
            return (r.status, "application/json", data, r.setCookie)
        }
        if req.path == "/licenses" {
            return (200, "text/html; charset=utf-8", Data(Self.licensesHTML.utf8), nil)
        }
        let (s, t, d) = staticAsset(req.path)
        // N7: the config PAGE being served to a browser is what retires the on-TV
        // setup card — not a hit on /api/status, which anything on the LAN can make.
        if s == 200, t.hasPrefix("text/html") { await api.markConfigPageOpened() }
        return (s, t, d, nil)
    }

    // LGPL compliance (see docs/vlckit-licensing.md): make users aware VLCKit is
    // embedded and point to its source. Reachable in-app at /licenses.
    private static let licensesHTML = """
    <!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
    <title>dumbTV — Licenses</title>
    <body style="font:16px/1.5 -apple-system,system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#111">
    <h1>Licenses &amp; Acknowledgements</h1>
    <p><b>dumbTV</b> turns a Plex library into a 1990s cable box.</p>
    <h2>VLCKit / libVLC</h2>
    <p>This app plays video using <b>VLCKit</b> (libVLC), &copy; VideoLAN and contributors,
    licensed under the <b>GNU Lesser General Public License, version 2.1 or later</b>.</p>
    <p>VLCKit is used unmodified and linked dynamically; you may obtain, modify, and
    relink it under the LGPL. Source code for the exact version is available from VideoLAN:</p>
    <ul>
      <li><a href="https://code.videolan.org/videolan/VLCKit">code.videolan.org/videolan/VLCKit</a></li>
      <li><a href="https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html">Full LGPL v2.1 text</a></li>
    </ul>
    <p style="color:#666">dumbTV's own code is separate from the LGPL library and is not covered by it.</p>
    <h2>Archivo Black</h2>
    <p>The display typeface is <b>Archivo Black</b>, &copy; the Archivo Black Project Authors
    (Omnibus-Type), licensed under the <b>SIL Open Font License 1.1</b>. The license text is
    bundled with the app as <code>ArchivoBlack-OFL.txt</code>.</p>
    """

    // MARK: - static web UI (bundled). Falls back to a placeholder until the
    // shared public/ assets are bundled (next Track G task).

    private func staticAsset(_ path: String) -> (Int, String, Data) {
        let decoded = path.removingPercentEncoding ?? path
        let rel = (decoded == "/" ? "index.html" : String(decoded.drop(while: { $0 == "/" })))
        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web") else {
            return decoded == "/"
                ? (200, "text/html; charset=utf-8", Data(Self.placeholder.utf8))
                : (404, "text/plain", Data("Not found".utf8))
        }
        // Resolve `..` and reject anything that escapes the web root — otherwise
        // GET /../../ would read files outside the bundle (path traversal).
        let root = webRoot.standardizedFileURL.path
        let fileURL = webRoot.appendingPathComponent(rel).standardizedFileURL
        guard fileURL.path == root || fileURL.path.hasPrefix(root + "/") else {
            return (403, "text/plain", Data("Forbidden".utf8))
        }
        if let data = try? Data(contentsOf: fileURL) {
            return (200, Self.mime(rel), data)
        }
        if decoded == "/" {   // web UI not bundled yet → placeholder
            return (200, "text/html; charset=utf-8", Data(Self.placeholder.utf8))
        }
        return (404, "text/plain", Data("Not found".utf8))
    }

    private static func mime(_ p: String) -> String {
        if p.hasSuffix(".html") { return "text/html; charset=utf-8" }
        if p.hasSuffix(".js")   { return "application/javascript" }
        if p.hasSuffix(".css")  { return "text/css" }
        if p.hasSuffix(".json") { return "application/json" }
        if p.hasSuffix(".svg")  { return "image/svg+xml" }
        return "application/octet-stream"
    }

    private static func reason(_ s: Int) -> String {
        switch s { case 200: return "OK"; case 400: return "Bad Request"
        case 404: return "Not Found"; default: return "Error" }
    }

    private static let placeholder = """
    <!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
    <title>dumbTV</title>
    <body style="font:16px -apple-system,system-ui;background:#0a2a6b;color:#ffb000;
      display:grid;place-items:center;height:100vh;margin:0;text-align:center">
    <div><h1 style="letter-spacing:.1em">dumbTV</h1>
    <p>Config server is running. The setup UI lands here next.</p>
    <p style="opacity:.7">API is live at <code>/api/status</code>.</p></div>
    """
}

/// A parsed HTTP request, or nil if the buffer doesn't yet hold a complete one
/// (caller keeps reading). Handles the request line, headers, and a
/// Content-Length body.
struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]
    let body: Data?

    init?(_ buffer: Data) {
        guard let sep = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }  // headers incomplete
        let headData = buffer.subdata(in: buffer.startIndex..<sep.lowerBound)
        guard let headStr = String(data: headData, encoding: .utf8) else { return nil }
        let lines = headStr.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let rl = requestLine.split(separator: " ")
        guard rl.count >= 2 else { return nil }
        method = String(rl[0])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let c = line.firstIndex(of: ":") else { continue }
            headers[line[..<c].lowercased()] =
                line[line.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        self.headers = headers

        // Wait for the whole body if the request declares a Content-Length.
        let bodyStart = sep.upperBound
        let declared = Int(headers["content-length"] ?? "0") ?? 0
        let available = buffer.distance(from: bodyStart, to: buffer.endIndex)
        if declared > available { return nil }   // body incomplete — keep reading
        body = declared > 0 ? buffer.subdata(in: bodyStart..<buffer.index(bodyStart, offsetBy: declared)) : nil

        // Split path and query string.
        let target = String(rl[1])
        if let q = target.firstIndex(of: "?") {
            path = String(target[..<q])
            var params: [String: String] = [:]
            for pair in target[target.index(after: q)...].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if let k = kv.first {
                    params[String(k).removingPercentEncoding ?? String(k)] =
                        kv.count > 1 ? (String(kv[1]).removingPercentEncoding ?? String(kv[1])) : ""
                }
            }
            query = params
        } else {
            path = target
            query = [:]
        }
    }
}
