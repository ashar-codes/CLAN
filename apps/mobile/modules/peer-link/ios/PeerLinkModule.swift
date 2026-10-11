// CLAN peer transport (iOS): clan-link/1 over TCP with Network.framework. `includePeerToPeer` lets two Apple devices
// reach each other over Apple's peer-to-peer Wi-Fi even with no router; the same listener and browser also work on any
// shared Wi-Fi or hotspot. Bonjour adverts carry only a random id. iOS does not run Wi-Fi Direct; Wi-Fi Aware (iOS 26)
// is not used in this build. Listening stops when iOS suspends the app — there is no indefinite background availability.
// NOT compiled in the cloud (no Xcode/iOS SDK there); see docs/PHASE_14_3_HARDWARE_TESTS.md.
import ExpoModulesCore
import Foundation
import Network
import NetworkExtension
import UIKit

private let serviceType = "_clanlink._tcp"
private let idPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,24}$")
private func validId(_ s: String) -> Bool { idPattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
private let tagPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{16}$")
private func validTag(_ s: String) -> Bool { tagPattern.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }

public class PeerLinkModule: Module {
  private let queue = DispatchQueue(label: "clan.peerlink")
  private var listener: NWListener?
  private var browser: NWBrowser?
  private var conns: [String: NWConnection] = [:]
  private var seq = 0
  private var advertR: String?
  private var advertT = ""
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

  private func params() -> NWParameters {
    let p = NWParameters.tcp
    p.includePeerToPeer = true
    if let tcp = p.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options { tcp.noDelay = true; tcp.enableKeepalive = true }
    return p
  }

  public func definition() -> ModuleDefinition {
    Name("PeerLink")
    Events("socket", "radio", "availability")

    Function("capabilities") { () -> [String: Any] in
      ["platform": "ios", "tcp": true, "nsd": true, "applePeerToPeer": true, "wifiDirect": false, "wifiAware": false,
       "wifiAwareAvailable": false, "localHotspot": false, "joinWifi": true]
    }

    AsyncFunction("listen") { (port: Int, promise: Promise) in
      guard (0...65535).contains(port) else { return promise.reject("LISTEN", "Bad port.") }
      self.queue.async {
        if let l = self.listener, let p = l.port { return promise.resolve(Int(p.rawValue)) }
        do {
          let l = try NWListener(using: self.params(), on: port > 0 ? (NWEndpoint.Port(rawValue: UInt16(port)) ?? .any) : .any)
          var settled = false
          l.stateUpdateHandler = { st in
            switch st {
            case .ready: if !settled { settled = true; promise.resolve(Int(l.port?.rawValue ?? 0)) }
            case .failed(let e): if !settled { settled = true; promise.reject("LISTEN", e.localizedDescription) }; self.listener = nil
            default: break
            }
          }
          l.newConnectionHandler = { c in
            if self.conns.count >= 32 { c.cancel(); return }
            let id = self.adopt(c)
            self.sendEvent("socket", ["id": id, "type": "accepted", "remote": "\(c.endpoint)"])
          }
          self.listener = l
          if let r = self.advertR { l.service = NWListener.Service(name: "clan-\(r.prefix(8))", type: serviceType, txtRecord: NWTXTRecord(["r": r, "t": self.advertT, "v": "1"]).data) }
          l.start(queue: self.queue)
        } catch { promise.reject("LISTEN", error.localizedDescription) }
      }
    }
    Function("stopListening") { self.queue.async { self.listener?.cancel(); self.listener = nil } }

    AsyncFunction("connect") { (host: String, port: Int, net: String?, promise: Promise) in
      guard (1...65535).contains(port), let p = NWEndpoint.Port(rawValue: UInt16(port)) else { return promise.reject("CONNECT", "Bad port.") }
      self.open(NWConnection(host: NWEndpoint.Host(host), port: p, using: self.params()), promise)
    }
    /** Connect to a Bonjour service found by `browse` (works over Apple peer-to-peer Wi-Fi as well as a shared network). */
    AsyncFunction("connectService") { (name: String, promise: Promise) in
      guard name.hasPrefix("clan-"), name.count <= 40 else { return promise.reject("CONNECT", "Bad service.") }
      self.open(NWConnection(to: .service(name: name, type: serviceType, domain: "local.", interface: nil), using: self.params()), promise)
    }
    Function("write") { (id: String, b64: String) -> Bool in
      guard b64.count <= 1_400_000, let d = Data(base64Encoded: b64) else { return false }
      return self.queue.sync {
        guard let c = self.conns[id] else { return false }
        c.send(content: d, completion: .contentProcessed { err in if err != nil { self.close(id) } })
        return true
      }
    }
    Function("close") { (id: String) in self.close(id) }

    Function("advertise") { (r: String, t: String, port: Int) in
      guard validId(r), t.isEmpty || validTag(t) else { return }
      self.queue.async {
        self.advertR = r; self.advertT = t
        self.listener?.service = NWListener.Service(name: "clan-\(r.prefix(8))", type: serviceType, txtRecord: NWTXTRecord(["r": r, "t": t, "v": "1"]).data)
      }
    }
    Function("addresses") { () -> [String] in PeerLinkModule.localAddresses() }
    Function("stopAdvertise") { self.queue.async { self.advertR = nil; self.listener?.service = nil } }
    Function("browse") {
      self.queue.async {
        self.browser?.cancel()
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: serviceType, domain: nil), using: self.params())
        b.browseResultsChangedHandler = { _, changes in
          for ch in changes {
            switch ch {
            case .added(let res):
              guard case let .service(name, _, _, _) = res.endpoint, name.hasPrefix("clan-") else { continue }
              var r = "", t = ""
              if case let .bonjour(txt) = res.metadata { r = txt["r"] ?? ""; t = txt["t"] ?? "" }
              if validId(r) { self.sendEvent("radio", ["type": "found", "via": "bonjour", "r": r, "t": validTag(t) ? t : "", "service": name]) }
            case .removed(let res):
              if case let .service(name, _, _, _) = res.endpoint { self.sendEvent("radio", ["type": "lost", "via": "bonjour", "name": name]) }
            default: break
            }
          }
        }
        b.stateUpdateHandler = { st in if case .failed(let e) = st { self.sendEvent("radio", ["type": "error", "via": "bonjour", "message": e.localizedDescription]) } }
        b.start(queue: self.queue)
        self.browser = b
      }
    }
    Function("stopBrowse") { self.queue.async { self.browser?.cancel(); self.browser = nil } }

    /** Join a nearby phone's hotspot (iOS shows its own confirmation; needs the Hotspot Configuration entitlement). */
    AsyncFunction("joinWifi") { (ssid: String, passphrase: String, promise: Promise) in
      guard !ssid.isEmpty, ssid.utf8.count <= 32, (8...63).contains(passphrase.count) else { return promise.reject("WIFI", "Invalid network details.") }
      let cfg = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
      cfg.joinOnce = true
      NEHotspotConfigurationManager.shared.apply(cfg) { err in
        if let e = err as NSError?, !(e.domain == NEHotspotConfigurationErrorDomain && e.code == NEHotspotConfigurationError.alreadyAssociated.rawValue) {
          promise.reject(e.code == NEHotspotConfigurationError.userDenied.rawValue ? "DENIED" : "WIFI", e.localizedDescription)
        } else { promise.resolve(nil) }
      }
    }
    Function("leaveWifi") { () in }

    // iOS cannot keep a listener running in the background. While a session is active we ask for the short
    // background time iOS grants to finish a transfer; calls keep running through the audio background mode.
    Function("availabilityStart") { (_: String) in
      DispatchQueue.main.async {
        if self.backgroundTask != .invalid { return }
        self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "clan-nearby") { self.endBackground() }
      }
    }
    Function("availabilityStop") { DispatchQueue.main.async { self.endBackground() } }
    Function("availabilityRunning") { () -> Bool in self.backgroundTask != .invalid }

    // Not on iOS: Wi-Fi Direct, Wi-Fi Aware data paths (iOS 26 framework not used in this build), creating a hotspot.
    AsyncFunction("p2pStart") { (_: String, _: String, _: Int, promise: Promise) in promise.reject("UNSUPPORTED", "Wi-Fi Direct is not available on iPhone.") }
    AsyncFunction("p2pConnect") { (_: String, promise: Promise) in promise.reject("UNSUPPORTED", "Wi-Fi Direct is not available on iPhone.") }
    Function("p2pDisconnect") { () in }
    Function("p2pStop") { () in }
    AsyncFunction("awareStart") { (_: String, _: String, _: Int, promise: Promise) in promise.reject("UNSUPPORTED", "Wi-Fi Aware is not used on iPhone in this version.") }
    AsyncFunction("awareConnect") { (_: String, promise: Promise) in promise.reject("UNSUPPORTED", "Wi-Fi Aware is not used on iPhone in this version.") }
    Function("awareStop") { () in }
    AsyncFunction("hotspotStart") { (promise: Promise) in promise.reject("UNSUPPORTED", "iPhone cannot create a hotspot from an app. Use Settings › Personal Hotspot, or join another phone's hotspot.") }
    Function("hotspotStop") { () in }

    OnDestroy { self.queue.async { self.listener?.cancel(); self.browser?.cancel(); for c in self.conns.values { c.cancel() }; self.conns.removeAll() } }
  }

  /** IPv4 addresses on Wi-Fi / hotspot interfaces (en*, bridge*), for the link addresses in this phone's QR. */
  static func localAddresses() -> [String] {
    var out: [String] = []
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return [] }
    defer { freeifaddrs(ifaddr) }
    for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let i = p.pointee
      guard let sa = i.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET), (i.ifa_flags & UInt32(IFF_UP)) != 0, (i.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
      let name = String(cString: i.ifa_name)
      guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 { out.append(String(cString: host)) }
    }
    return Array(Set(out)).prefix(4).map { $0 }
  }

  private func endBackground() { if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid } }

  private func open(_ c: NWConnection, _ promise: Promise) {
    queue.async {
      guard self.conns.count < 32 else { c.cancel(); return promise.reject("CONNECT", "Too many connections.") }
      var settled = false
      let id = self.adopt(c, ready: { ok, err in
        if settled { return }; settled = true
        if ok { promise.resolve(self.conns.first(where: { $0.value === c })?.key ?? "") } else { promise.reject("CONNECT", err ?? "Not reachable.") }
      })
      _ = id
      self.queue.asyncAfter(deadline: .now() + 8) { if !settled { settled = true; c.cancel(); promise.reject("CONNECT", "Not reachable.") } }
    }
  }

  @discardableResult
  private func adopt(_ c: NWConnection, ready: ((Bool, String?) -> Void)? = nil) -> String {
    seq += 1
    let id = "s\(seq)"
    conns[id] = c
    c.stateUpdateHandler = { st in
      switch st {
      case .ready: ready?(true, nil)
      case .failed(let e): ready?(false, e.localizedDescription); self.close(id)
      case .cancelled: self.close(id)
      default: break
      }
    }
    receive(id, c)
    c.start(queue: queue)
    return id
  }

  private func receive(_ id: String, _ c: NWConnection) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, err in
      if let data, !data.isEmpty { self.sendEvent("socket", ["id": id, "type": "data", "data": data.base64EncodedString()]) }
      if done || err != nil { self.close(id); return }
      self.receive(id, c)
    }
  }

  private func close(_ id: String) {
    queue.async {
      guard let c = self.conns.removeValue(forKey: id) else { return }
      c.cancel()
      self.sendEvent("socket", ["id": id, "type": "closed"])
    }
  }
}
