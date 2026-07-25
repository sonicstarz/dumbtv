import Foundation
import SQLite3

/// A thin, dependency-free wrapper over the system SQLite3 C library. Keeps
/// `dumbTVCore` self-contained (no SPM deps) while giving the Store ergonomic
/// bind/query helpers. **Thread-safe**: every operation is serialised by a
/// recursive lock, so the one connection can be shared across the embedded
/// server's concurrent request handlers.
public final class SQLite {
    private var db: OpaquePointer?
    /// Serialises all access to the single connection. Recursive so a
    /// `transaction` can call `run`/`query`/`exec` while holding it.
    private let lock = NSRecursiveLock()

    /// SQLite wants to copy bound text/blob bytes (they may be freed after bind).
    static let TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public enum Value: Equatable {
        case int(Int64), double(Double), text(String), null
    }

    public init(path: String) throws {
        if sqlite3_open(path, &db) != SQLITE_OK { throw error("open") }
        exec("PRAGMA journal_mode=WAL;")
        exec("PRAGMA foreign_keys=ON;")
    }

    deinit { sqlite3_close(db) }

    /// Run raw SQL with no bindings/results (schema, pragmas, transactions).
    @discardableResult
    public func exec(_ sql: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }

    /// Total rows inserted/updated/deleted on this connection since open —
    /// a cheap change stamp. The player polls it to notice web-UI edits even
    /// if a change notification is ever missed.
    public func totalChanges() -> Int {
        lock.lock(); defer { lock.unlock() }
        return Int(sqlite3_total_changes(db))
    }

    /// INSERT/UPDATE/DELETE with bindings. Returns the last inserted rowid.
    @discardableResult
    public func run(_ sql: String, _ params: [Value] = []) throws -> Int64 {
        lock.lock(); defer { lock.unlock() }
        let stmt = try prepare(sql, params)
        defer { sqlite3_finalize(stmt) }
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else { throw error("step") }
        return sqlite3_last_insert_rowid(db)
    }

    /// SELECT returning rows keyed by column name.
    public func query(_ sql: String, _ params: [Value] = []) throws -> [Row] {
        lock.lock(); defer { lock.unlock() }
        let stmt = try prepare(sql, params)
        defer { sqlite3_finalize(stmt) }
        var rows: [Row] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var cols: [String: Value] = [:]
            for i in 0..<sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, i))
                cols[name] = columnValue(stmt, i)
            }
            rows.append(Row(cols))
        }
        return rows
    }

    /// Run `body` inside a transaction; rolls back if it throws. The lock is held
    /// for the whole transaction so it's atomic against concurrent callers.
    public func transaction(_ body: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        exec("BEGIN")
        do { try body(); exec("COMMIT") }
        catch { exec("ROLLBACK"); throw self.error("transaction rolled back: \(error.localizedDescription)") }
    }

    // MARK: - internals

    private func prepare(_ sql: String, _ params: [Value]) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw error("prepare (\(sql))")
        }
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            switch p {
            case .int(let v):    sqlite3_bind_int64(stmt, idx, v)
            case .double(let v): sqlite3_bind_double(stmt, idx, v)
            case .text(let v):   sqlite3_bind_text(stmt, idx, v, -1, Self.TRANSIENT)
            case .null:          sqlite3_bind_null(stmt, idx)
            }
        }
        return stmt
    }

    private func columnValue(_ stmt: OpaquePointer?, _ i: Int32) -> Value {
        switch sqlite3_column_type(stmt, i) {
        case SQLITE_INTEGER: return .int(sqlite3_column_int64(stmt, i))
        case SQLITE_FLOAT:   return .double(sqlite3_column_double(stmt, i))
        case SQLITE_NULL:    return .null
        default:
            if let c = sqlite3_column_text(stmt, i) { return .text(String(cString: c)) }
            return .null
        }
    }

    private func error(_ ctx: String) -> Error {
        let msg = db != nil ? String(cString: sqlite3_errmsg(db)) : "no handle"
        // The Store deliberately uses `try?` at call sites (a failed read must
        // never crash the TV), so this is the one place a SQL failure is visible.
        // Log it — a swallowed write was previously indistinguishable from success.
        print("dumbTV SQLite error — \(ctx): \(msg)")
        return NSError(domain: "SQLite", code: 1,
                       userInfo: [NSLocalizedDescriptionKey: "\(ctx): \(msg)"])
    }
}

public extension SQLite.Value {
    var intValue: Int64?  { if case .int(let v) = self { return v }; if case .double(let d) = self { return Int64(d) }; return nil }
    var doubleValue: Double? { if case .double(let v) = self { return v }; if case .int(let i) = self { return Double(i) }; return nil }
    var textValue: String? { if case .text(let v) = self { return v }; return nil }
}

/// A query result row with typed column accessors.
public struct Row {
    private let cols: [String: SQLite.Value]
    init(_ cols: [String: SQLite.Value]) { self.cols = cols }

    public func int(_ k: String) -> Int64?    { cols[k]?.intValue }
    public func intOr(_ k: String, _ d: Int) -> Int { Int(cols[k]?.intValue ?? Int64(d)) }
    public func double(_ k: String) -> Double? { cols[k]?.doubleValue }
    public func text(_ k: String) -> String?   { cols[k]?.textValue }
    public func bool(_ k: String) -> Bool      { (cols[k]?.intValue ?? 0) != 0 }
}
