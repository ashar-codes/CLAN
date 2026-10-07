// Joins the CLAN Direct Wi-Fi with a credential that arrived inside an authenticated OPAQUE exchange (or a scanned QR).
// iOS asks the user to confirm ("Join Wi-Fi network?"); needs the Hotspot Configuration entitlement.
import Foundation
import NetworkExtension

enum DirectWifi {
  static func join(ssid: String, passphrase: String, completion: @escaping (String?) -> Void) {
    guard ssid.range(of: "^CLAN-[0-9A-Z]{4}$", options: .regularExpression) != nil,
          passphrase.range(of: "^[A-Za-z0-9]{16,63}$", options: .regularExpression) != nil else { return completion("Invalid network credential.") }
    let cfg = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
    cfg.joinOnce = true // forgotten when CLAN stops using it
    NEHotspotConfigurationManager.shared.apply(cfg) { error in
      guard let e = error as NSError? else { return completion(nil) }
      if e.domain == NEHotspotConfigurationErrorDomain, e.code == NEHotspotConfigurationError.alreadyAssociated.rawValue { return completion(nil) }
      if e.domain == NEHotspotConfigurationErrorDomain, e.code == NEHotspotConfigurationError.userDenied.rawValue { return completion("denied") }
      completion(e.localizedDescription)
    }
  }
  static func leave(ssid: String) { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
}
