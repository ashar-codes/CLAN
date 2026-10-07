// Expo wrapper for DirectBle + DirectWifi. NOT compiled on the development machine (needs ExpoModulesCore/Xcode);
// DirectBle.swift and DirectWifi.swift are type-checked against the iOS SDK (docs/TESTING.md).
import ExpoModulesCore
import Foundation

public class DirectJoinModule: Module {
  private lazy var ble: DirectBle = {
    let b = DirectBle()
    b.onFrame = { [weak self] conn, data in self?.sendEvent("bleFrame", ["conn": conn, "frame": data.base64EncodedString()]) }
    return b
  }()

  public func definition() -> ModuleDefinition {
    Name("DirectJoin")
    Events("bleFrame")
    Function("bluetoothState") { () -> String in self.ble.state }
    AsyncFunction("joinWifi") { (ssid: String, passphrase: String, promise: Promise) in
      DirectWifi.join(ssid: ssid, passphrase: passphrase) { err in
        if let err { promise.reject(err == "denied" ? "DENIED" : "WIFI", err == "denied" ? "You declined joining the CLAN network." : err) } else { promise.resolve(nil) }
      }
    }
    AsyncFunction("bleScan") { (ms: Int, promise: Promise) in
      self.ble.scan(ms: ms) { ids, err in if let ids { promise.resolve(ids) } else { promise.reject("BLE", err ?? "unknown") } }
    }
    AsyncFunction("bleConnect") { (peer: String, promise: Promise) in
      self.ble.connect(peer: peer) { conn, err in if let conn { promise.resolve(conn) } else { promise.reject("BLE", err ?? "failed") } }
    }
    Function("bleWrite") { (conn: String, frameB64: String) -> Bool in
      guard let d = Data(base64Encoded: frameB64) else { return false }
      return self.ble.write(conn: conn, frame: d)
    }
    Function("bleClose") { (conn: String) in self.ble.close(conn: conn) }
  }
}
