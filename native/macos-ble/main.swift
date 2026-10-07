// clan-ble: macOS BLE central for the CLAN Direct bootstrap. Same JSON-lines protocol as the Windows helper, but only
// the member commands: ble.scan / ble.connect / ble.write / ble.close. It carries opaque OPAQUE frames; nothing else.
import CoreBluetooth
import Foundation

let service = CBUUID(string: "6f1a0001-7c3b-4d5e-9a2b-c1a4e5f60001")
let rxUUID = CBUUID(string: "6f1a0002-7c3b-4d5e-9a2b-c1a4e5f60001")
let txUUID = CBUUID(string: "6f1a0003-7c3b-4d5e-9a2b-c1a4e5f60001")

func emit(_ o: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}
func reply(_ id: String, _ result: Any? = nil, error: String? = nil) {
  if let error { emit(["id": id, "ok": false, "error": String(error.prefix(300))]) } else { emit(["id": id, "ok": true, "result": result ?? NSNull()]) }
}

final class Central: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  var cm: CBCentralManager!
  var found: [String: CBPeripheral] = [:]          // id (12 hex) -> peripheral
  var conns: [String: (p: CBPeripheral, rx: CBCharacteristic)] = [:]
  var pendingConnect: [UUID: (id: String, conn: String)] = [:]
  var scanReply: String?
  var ready: [() -> Void] = []

  override init() { super.init(); cm = CBCentralManager(delegate: self, queue: .main) }

  func whenOn(_ f: @escaping () -> Void, fail: @escaping (String) -> Void) {
    switch cm.state {
    case .poweredOn: f()
    case .unauthorized: fail("Bluetooth permission denied.")
    case .unsupported: fail("Bluetooth LE is not supported on this Mac.")
    case .poweredOff: fail("Bluetooth is off.")
    default:
      ready.append(f)
      // No answer from the system (permission prompt pending, or run outside an app bundle): fail instead of hanging.
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if self.cm.state != .poweredOn && !self.ready.isEmpty { self.ready = []; fail("Bluetooth is not available to CLAN (permission or settings).") } }
    }
  }
  func centralManagerDidUpdateState(_ c: CBCentralManager) { if c.state == .poweredOn { ready.forEach { $0() }; ready = [] } }

  static func idOf(_ p: CBPeripheral) -> String { String(p.identifier.uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12)) }

  func scan(_ id: String, ms: Int) {
    whenOn({
      self.found = [:]; self.scanReply = id
      self.cm.scanForPeripherals(withServices: [service])
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(min(max(ms, 500), 15000))) {
        self.cm.stopScan()
        reply(id, ["hosts": self.found.keys.map { ["id": $0] }])
      }
    }, fail: { reply(id, error: $0) })
  }
  func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) { found[Central.idOf(p)] = p }

  func connect(_ id: String, peer: String) {
    guard let p = found[peer] else { return reply(id, error: "Host not found; scan again.") }
    pendingConnect[p.identifier] = (id, UUID().uuidString)
    p.delegate = self
    cm.connect(p)
  }
  func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices([service]) }
  func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    if let w = pendingConnect.removeValue(forKey: p.identifier) { reply(w.id, error: "Bluetooth connection failed.") }
  }
  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard let s = p.services?.first(where: { $0.uuid == service }) else { return fail(p, "Not a CLAN host.") }
    p.discoverCharacteristics([rxUUID, txUUID], for: s)
  }
  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
    guard let rx = s.characteristics?.first(where: { $0.uuid == rxUUID }), let tx = s.characteristics?.first(where: { $0.uuid == txUUID }) else { return fail(p, "Not a CLAN host.") }
    p.setNotifyValue(true, for: tx)
    if let w = pendingConnect.removeValue(forKey: p.identifier) { conns[w.conn] = (p, rx); reply(w.id, ["conn": w.conn]) }
  }
  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
    guard ch.uuid == txUUID, let v = ch.value, v.count <= 180, let conn = conns.first(where: { $0.value.p == p })?.key else { return }
    emit(["ev": "ble.frame", "conn": conn, "frame": v.base64EncodedString()])
  }
  func fail(_ p: CBPeripheral, _ msg: String) {
    if let w = pendingConnect.removeValue(forKey: p.identifier) { reply(w.id, error: msg) }
    cm.cancelPeripheralConnection(p)
  }
  func write(_ id: String, conn: String, frame: Data) {
    guard let c = conns[conn], frame.count <= 180 else { return reply(id, error: "Not connected.") }
    c.p.writeValue(frame, for: c.rx, type: .withoutResponse)
    reply(id)
  }
  func close(_ id: String, conn: String) {
    if let c = conns.removeValue(forKey: conn) { cm.cancelPeripheralConnection(c.p) }
    reply(id)
  }
}

let central = Central()
let hex12 = try! NSRegularExpression(pattern: "^[0-9a-f]{12}$")
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard line.utf8.count <= 8192, let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let id = o["id"] as? String, let cmd = o["cmd"] as? String else { continue }
    DispatchQueue.main.async {
      switch cmd {
      case "ble.scan": central.scan(id, ms: o["ms"] as? Int ?? 3000)
      case "ble.connect":
        guard let peer = o["peer"] as? String, hex12.firstMatch(in: peer, range: NSRange(peer.startIndex..., in: peer)) != nil else { return reply(id, error: "invalid peer") }
        central.connect(id, peer: peer)
      case "ble.write":
        guard let conn = o["conn"] as? String, let f = o["frame"] as? String, let data = Data(base64Encoded: f) else { return reply(id, error: "invalid frame") }
        central.write(id, conn: conn, frame: data)
      case "ble.close": central.close(id, conn: o["conn"] as? String ?? "")
      default: reply(id, error: "unknown command")
      }
    }
  }
  exit(0)
}
RunLoop.main.run()
