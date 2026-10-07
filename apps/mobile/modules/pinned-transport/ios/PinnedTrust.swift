// Classroom LAN pinned trust (iOS; also compiles on macOS, where it is exercised by tests/pinned-trust-check).
//
// Trust rule (the only one): the server chain must validate with the per-class CA from the OPAQUE-authenticated
// binding as the SOLE anchor (system and user-installed roots are ignored), AND the leaf's SubjectPublicKeyInfo
// SHA-256 must equal the pinned value. Host names are not checked: the pin is the identity (the leaf has no SAN).
import Foundation
import Security
import CryptoKit

// DER prefix of a P-256 SubjectPublicKeyInfo; SecKeyCopyExternalRepresentation returns only the 65-byte point.
private let p256SpkiPrefix: [UInt8] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                       0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]

final class PinnedTrust: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate {
  let anchor: SecCertificate
  let pin: String
  var wsIds: [Int: String] = [:]
  /** Event sink (the Expo module); kept as a closure so this file compiles without ExpoModulesCore. */
  var emit: (String, [String: Any]) -> Void = { _, _ in }

  init(anchor: SecCertificate, pin: String) { self.anchor = anchor; self.pin = pin }

  func evaluate(_ trust: SecTrust) -> Bool {
    SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
    SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
    SecTrustSetAnchorCertificatesOnly(trust, true)
    var error: CFError?
    guard SecTrustEvaluateWithError(trust, &error),
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = chain.first,
          let key = SecCertificateCopyKey(leaf),
          let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
          (attrs[kSecAttrKeyType] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String),
          (attrs[kSecAttrKeySizeInBits] as? Int) == 256,
          let raw = SecKeyCopyExternalRepresentation(key, nil) as Data? else { return false }
    let digest = SHA256.hash(data: Data(p256SpkiPrefix) + raw)
    return Data(digest).base64EncodedString() == pin
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust, evaluate(trust) else {
      completionHandler(.cancelAuthenticationChallenge, nil); return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }


  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    if let id = wsIds[webSocketTask.taskIdentifier] { emit("wsOpen", ["id": id]) }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    if let id = wsIds.removeValue(forKey: webSocketTask.taskIdentifier) {
      emit("wsClose", ["id": id, "code": closeCode.rawValue, "reason": reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""])
    }
  }
}

