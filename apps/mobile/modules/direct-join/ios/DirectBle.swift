// BLE central for the CLAN Direct bootstrap (foreground use). Carries only OPAQUE pairing frames (≤180 bytes).
import CoreBluetooth
import Foundation

final class DirectBle: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  static let service = CBUUID(string: "6f1a0001-7c3b-4d5e-9a2b-c1a4e5f60001")
  static let rxUUID = CBUUID(string: "6f1a0002-7c3b-4d5e-9a2b-c1a4e5f60001")
  static let txUUID = CBUUID(string: "6f1a0003-7c3b-4d5e-9a2b-c1a4e5f60001")

  var onFrame: (String, Data) -> Void = { _, _ in }
  private var cm: CBCentralManager!
  private var found: [String: CBPeripheral] = [:]
  private var conns: [String: (p: CBPeripheral, rx: CBCharacteristic)] = [:]
  private var pending: [UUID: (conn: String, done: (String?, String?) -> Void)] = [:]
  private var waiting: [(Bool) -> Void] = []

  override init() { super.init(); cm = CBCentralManager(delegate: self, queue: .main) }

  /** "on" | "off" | "denied" | "unsupported" | "unknown" */
  var state: String {
    switch cm.state { case .poweredOn: return "on"; case .poweredOff: return "off"; case .unauthorized: return "denied"; case .unsupported: return "unsupported"; default: return "unknown" }
  }
  private func whenReady(_ f: @escaping (Bool) -> Void) {
    if cm.state == .poweredOn { return f(true) }
    if cm.state == .poweredOff || cm.state == .unauthorized || cm.state == .unsupported { return f(false) }
    waiting.append(f)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if !self.waiting.isEmpty { let w = self.waiting; self.waiting = []; w.forEach { $0(false) } } }
  }
  func centralManagerDidUpdateState(_ c: CBCentralManager) { if c.state != .unknown && c.state != .resetting { let w = waiting; waiting = []; w.forEach { $0(c.state == .poweredOn) } } }

  func scan(ms: Int, done: @escaping ([String]?, String?) -> Void) {
    whenReady { ok in
      guard ok else { return done(nil, self.state) }
      self.found = [:]
      self.cm.scanForPeripherals(withServices: [DirectBle.service])
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(min(max(ms, 500), 15000))) { self.cm.stopScan(); done(Array(self.found.keys), nil) }
    }
  }
  func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
    found[String(p.identifier.uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))] = p
  }
  func connect(peer: String, done: @escaping (String?, String?) -> Void) {
    guard let p = found[peer] else { return done(nil, "Host not found; scan again.") }
    pending[p.identifier] = (UUID().uuidString, done)
    p.delegate = self
    cm.connect(p)
  }
  func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices([DirectBle.service]) }
  func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { finish(p, nil, "Bluetooth connection failed.") }
  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard let s = p.services?.first(where: { $0.uuid == DirectBle.service }) else { return finish(p, nil, "Not a CLAN host.") }
    p.discoverCharacteristics([DirectBle.rxUUID, DirectBle.txUUID], for: s)
  }
  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
    guard let rx = s.characteristics?.first(where: { $0.uuid == DirectBle.rxUUID }), let tx = s.characteristics?.first(where: { $0.uuid == DirectBle.txUUID }) else { return finish(p, nil, "Not a CLAN host.") }
    p.setNotifyValue(true, for: tx)
    if let w = pending[p.identifier] { conns[w.conn] = (p, rx) }
    finish(p, pending[p.identifier]?.conn, nil)
  }
  private func finish(_ p: CBPeripheral, _ conn: String?, _ err: String?) {
    guard let w = pending.removeValue(forKey: p.identifier) else { return }
    if err != nil { cm.cancelPeripheralConnection(p) }
    w.done(conn, err)
  }
  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
    guard ch.uuid == DirectBle.txUUID, let v = ch.value, v.count <= 180, let conn = conns.first(where: { $0.value.p == p })?.key else { return }
    onFrame(conn, v)
  }
  func write(conn: String, frame: Data) -> Bool {
    guard let c = conns[conn], frame.count <= 180 else { return false }
    c.p.writeValue(frame, for: c.rx, type: .withoutResponse)
    return true
  }
  func close(conn: String) { if let c = conns.removeValue(forKey: conn) { cm.cancelPeripheralConnection(c.p) } }
}
