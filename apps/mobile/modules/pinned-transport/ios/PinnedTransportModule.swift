// Classroom LAN pinned transport (iOS Expo module). The trust decision lives in PinnedTrust.swift.
// This file is NOT compiled on the development machine (needs ExpoModulesCore/Xcode) — see docs/TESTING.md.
import ExpoModulesCore
import Foundation

private struct Conn { let session: URLSession; let trust: PinnedTrust }

/** Per-upload progress (task-level delegate; server trust is still decided by the session delegate above). */
private final class UploadProgress: NSObject, URLSessionTaskDelegate {
  let id: String; let offset: Int64; weak var module: PinnedTransportModule?
  init(id: String, offset: Int64, module: PinnedTransportModule) { self.id = id; self.offset = offset; self.module = module }
  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    module?.sendEvent("progress", ["id": id, "bytes": offset + totalBytesSent])
  }
}

public class PinnedTransportModule: Module {
  private var conns: [String: Conn] = [:]
  private var running: [String: URLSessionTask] = [:]
  private var sockets: [String: URLSessionWebSocketTask] = [:]
  private let lock = NSLock()

  private func conn(_ id: String) throws -> Conn {
    lock.lock(); defer { lock.unlock() }
    guard let c = conns[id] else { throw Exception(name: "NotConfigured", description: "Unknown pinned connection") }
    return c
  }

  private func request(_ url: String, _ method: String, _ headers: [String: String]) throws -> URLRequest {
    guard let u = URL(string: url), u.scheme == "https" || u.scheme == "wss" else { throw Exception(name: "Insecure", description: "Only https/wss") }
    var r = URLRequest(url: u)
    r.httpMethod = method
    r.cachePolicy = .reloadIgnoringLocalCacheData
    for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
    return r
  }

  public func definition() -> ModuleDefinition {
    Name("PinnedTransport")
    Events("progress", "wsOpen", "wsMessage", "wsClose")

    Function("configure") { (id: String, caDerB64: String, pinB64: String) in
      guard let der = Data(base64Encoded: caDerB64), let ca = SecCertificateCreateWithData(nil, der as CFData) else {
        throw Exception(name: "BadCertificate", description: "Invalid classroom CA")
      }
      let trust = PinnedTrust(anchor: ca, pin: pinB64)
      trust.emit = { [weak self] name, body in self?.sendEvent(name, body) }
      let cfg = URLSessionConfiguration.ephemeral // no cookies, cache or credential storage
      cfg.tlsMinimumSupportedProtocolVersion = .TLSv13
      cfg.waitsForConnectivity = false
      let session = URLSession(configuration: cfg, delegate: trust, delegateQueue: nil)
      self.lock.lock(); self.conns[id] = Conn(session: session, trust: trust); self.lock.unlock()
    }

    Function("release") { (id: String) in
      self.lock.lock(); let c = self.conns.removeValue(forKey: id); self.lock.unlock()
      c?.session.invalidateAndCancel()
    }

    AsyncFunction("request") { (id: String, method: String, url: String, headers: [String: String], body: String?) -> [String: Any] in
      let c = try self.conn(id)
      var r = try self.request(url, method, headers)
      if let body = body { r.httpBody = body.data(using: .utf8) }
      let (data, resp) = try await c.session.data(for: r)
      let http = resp as! HTTPURLResponse
      var h: [String: String] = [:]
      for (k, v) in http.allHeaderFields { h[String(describing: k).lowercased()] = String(describing: v) }
      return ["status": http.statusCode, "headers": h, "body": String(data: data, encoding: .utf8) ?? ""]
    }

    // Streams the body to `path` (appending when `append`), emitting progress; returns status + bytes on disk.
    AsyncFunction("download") { (id: String, reqId: String, url: String, headers: [String: String], path: String, append: Bool) -> [String: Any] in
      let c = try self.conn(id)
      let r = try self.request(url, "GET", headers)
      let file = URL(string: path)?.path ?? path
      if !append || !FileManager.default.fileExists(atPath: file) { FileManager.default.createFile(atPath: file, contents: nil) }
      let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
      defer { try? handle.close() }
      var written = try handle.seekToEnd()
      let (bytes, resp) = try await c.session.bytes(for: r)
      self.lock.lock(); self.running[reqId] = bytes.task; self.lock.unlock()
      defer { self.lock.lock(); self.running.removeValue(forKey: reqId); self.lock.unlock() }
      let status = (resp as! HTTPURLResponse).statusCode
      guard status == 200 || status == 206 else { return ["status": status, "bytes": written] }
      if status == 200 && written > 0 { try handle.truncate(atOffset: 0); written = 0 } // server sent the whole file
      var buf = Data(); buf.reserveCapacity(1 << 16)
      var lastEmit = Date.distantPast
      for try await b in bytes {
        buf.append(b)
        if buf.count >= 1 << 16 {
          try handle.write(contentsOf: buf); written += UInt64(buf.count); buf.removeAll(keepingCapacity: true)
          if Date().timeIntervalSince(lastEmit) > 0.25 { lastEmit = Date(); self.sendEvent("progress", ["id": reqId, "bytes": written]) }
        }
      }
      if !buf.isEmpty { try handle.write(contentsOf: buf); written += UInt64(buf.count) }
      return ["status": status, "bytes": written]
    }

    AsyncFunction("upload") { (id: String, reqId: String, url: String, headers: [String: String], path: String, offset: Double) -> [String: Any] in
      let c = try self.conn(id)
      var r = try self.request(url, "PUT", headers)
      let file = URL(string: path)?.path ?? path
      let size = (try FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value ?? 0
      guard let stream = InputStream(fileAtPath: file) else { throw Exception(name: "NoFile", description: "Cannot read file") }
      stream.setProperty(NSNumber(value: Int64(offset)), forKey: .fileCurrentOffsetKey)
      r.httpBodyStream = stream
      r.setValue(String(size - Int64(offset)), forHTTPHeaderField: "Content-Length")
      let (data, resp) = try await c.session.data(for: r, delegate: UploadProgress(id: reqId, offset: Int64(offset), module: self))
      return ["status": (resp as! HTTPURLResponse).statusCode, "body": String(data: data, encoding: .utf8) ?? ""]
    }

    Function("cancel") { (reqId: String) in
      self.lock.lock(); let t = self.running.removeValue(forKey: reqId); self.lock.unlock()
      t?.cancel()
    }

    Function("wsOpen") { (id: String, wsId: String, url: String) in
      let c = try self.conn(id)
      let task = c.session.webSocketTask(with: try self.request(url, "GET", [:]))
      task.maximumMessageSize = 1 << 20
      c.trust.wsIds[task.taskIdentifier] = wsId
      self.lock.lock(); self.sockets[wsId] = task; self.lock.unlock()
      func receive() {
        task.receive { [weak self] result in
          switch result {
          case .success(.string(let s)): self?.sendEvent("wsMessage", ["id": wsId, "data": s]); receive()
          case .success: receive()
          case .failure: self?.sendEvent("wsClose", ["id": wsId, "code": 1006, "reason": ""])
          }
        }
      }
      task.resume()
      receive()
    }

    AsyncFunction("wsSend") { (wsId: String, text: String) in
      self.lock.lock(); let t = self.sockets[wsId]; self.lock.unlock()
      try await t?.send(.string(text))
    }

    Function("wsClose") { (wsId: String, code: Int, reason: String) in
      self.lock.lock(); let t = self.sockets.removeValue(forKey: wsId); self.lock.unlock()
      t?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason.data(using: .utf8))
    }
  }
}
