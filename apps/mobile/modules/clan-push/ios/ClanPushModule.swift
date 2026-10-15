// iOS half of CLAN wake-ups (docs/FINAL_IOS_PUSH_CALLKIT.md). Active only when the build sets Info.plist CLANVoIPPush
// (needs the Push Notifications capability, aps-environment and the voip background mode — a paid Apple team).
// Every VoIP push must be reported to CallKit (iOS rule); an unverifiable one is reported and ended immediately, so a
// relay or provider can never make CLAN ring with a fake caller. Media starts only after the user answers in CLAN.
import ExpoModulesCore
import PushKit
import CallKit
import CryptoKit
import Foundation

final class ClanVoip: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  static let shared = ClanVoip()
  let defaults = UserDefaults.standard
  var token: String?
  private var registry: PKPushRegistry?
  private lazy var provider: CXProvider = {
    let c = CXProviderConfiguration(); c.supportsVideo = true; c.maximumCallsPerCallGroup = 1; c.supportedHandleTypes = [.generic]
    let p = CXProvider(configuration: c); p.setDelegate(self, queue: nil); return p
  }()
  private var timers: [UUID: Timer] = [:]
  static var enabled: Bool { (Bundle.main.object(forInfoDictionaryKey: "CLANVoIPPush") as? Bool) == true }

  func start() {
    guard ClanVoip.enabled, registry == nil else { return }
    DispatchQueue.main.async { let r = PKPushRegistry(queue: .main); r.delegate = self; r.desiredPushTypes = [.voIP]; self.registry = r }
  }
  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    token = credentials.token.map { String(format: "%02x", $0) }.joined()
  }
  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) { token = nil }

  private func b64(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"); while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }
  private func friend(_ capId: String) -> (name: String, mac: String)? {
    guard let raw = defaults.string(forKey: "clanPush.keys"), let arr = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [[String: Any]] else { return nil }
    for o in arr where (o["capId"] as? String) == capId { if let n = o["name"] as? String, let m = o["mac"] as? String { return (n, m) } }
    return nil
  }
  func firstTime(_ key: String) -> Bool {
    var seen = defaults.stringArray(forKey: "clanPush.shown") ?? []
    if seen.contains(key) { return false }
    seen.append(key); defaults.set(Array(seen.suffix(200)), forKey: "clanPush.shown"); return true
  }
  func record(_ e: [String: String]) { var a = defaults.array(forKey: "clanPush.events") as? [[String: String]] ?? []; a.append(e); defaults.set(a, forKey: "clanPush.events") }

  /** (kind, id, name) when the event verifies with the friend's key and has not expired. */
  func verify(_ d: [String: Any], now: Double = Date().timeIntervalSince1970 * 1000) -> (k: String, id: String, name: String, exp: Double, c: String)? {
    guard let k = d["k"] as? String, let id = d["id"] as? String, let exp = (d["exp"] as? NSNumber)?.doubleValue, let c = d["c"] as? String, let m = d["m"] as? String,
          let f = friend(c), let key = b64(f.mac), let got = b64(m), exp > now, exp <= now + 24 * 3_600_000 + 120_000 else { return nil }
    let expText = String(format: "%.0f", exp)
    let want = Data(HMAC<SHA256>.authenticationCode(for: Data("clan-push-ev/v1|\(k)|\(id)|\(expText)|\(c)".utf8), using: SymmetricKey(data: key))).prefix(16)
    guard want.count == got.count, zip(want, got).reduce(0, { $0 | ($1.0 ^ $1.1) }) == 0 else { return nil }
    let previews = defaults.object(forKey: "clanPush.previews") as? Bool ?? true
    return (k, id, previews ? f.name : "A friend", exp, c)
  }

  func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
    let d = payload.dictionaryPayload["clan"] as? [String: Any] ?? [:]
    let v = verify(d), uuid = UUID(uuidString: (d["id"] as? String) ?? "") ?? UUID()
    let update = CXCallUpdate(); update.remoteHandle = CXHandle(type: .generic, value: v?.name ?? "CLAN"); update.localizedCallerName = v?.name ?? "CLAN"
    provider.reportNewIncomingCall(with: uuid, update: update) { _ in
      guard let v = v, v.k == "call", self.firstTime("call:\(v.id)") else {
        // Not a genuine, fresh call (or a cancellation): end it at once — never ring for an unverified push.
        self.provider.reportCall(with: uuid, endedAt: nil, reason: v?.k == "call.cancel" ? .remoteEnded : .failed)
        if let v = v, v.k == "call.cancel" { self.record(["k": "call.cancel", "id": v.id, "c": v.c, "action": "missed"]) }
        completion(); return
      }
      let left = max(1, v.exp / 1000 - Date().timeIntervalSince1970)
      self.timers[uuid] = Timer.scheduledTimer(withTimeInterval: left, repeats: false) { _ in self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered); self.record(["k": "call", "id": v.id, "c": v.c, "action": "missed"]) }
      completion()
    }
  }
  func providerDidReset(_ provider: CXProvider) {}
  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    timers.removeValue(forKey: action.callUUID)?.invalidate()
    record(["k": "call", "id": action.callUUID.uuidString.lowercased(), "action": "answer"]); action.fulfill()
  }
  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    timers.removeValue(forKey: action.callUUID)?.invalidate()
    record(["k": "call", "id": action.callUUID.uuidString.lowercased(), "action": "decline"]); action.fulfill()
  }
  func end(_ id: String) { if let u = UUID(uuidString: id) { timers.removeValue(forKey: u)?.invalidate(); provider.reportCall(with: u, endedAt: nil, reason: .remoteEnded) } }
}

public class ClanPushModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ClanPush")
    OnCreate { ClanVoip.shared.start() }
    Function("configured") { ClanVoip.enabled }
    AsyncFunction("token") { () -> String? in ClanVoip.shared.token }
    Function("setKeys") { (json: String) in UserDefaults.standard.set(json, forKey: "clanPush.keys") }
    Function("setPreviews") { (on: Bool) in UserDefaults.standard.set(on, forKey: "clanPush.previews") }
    Function("firstTime") { (key: String) -> Bool in ClanVoip.shared.firstTime(key) }
    Function("takeEvents") { () -> String in
      let a = UserDefaults.standard.array(forKey: "clanPush.events") ?? []; UserDefaults.standard.set([], forKey: "clanPush.events")
      return String(data: (try? JSONSerialization.data(withJSONObject: a)) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
    }
    Function("cancelCall") { (id: String) in DispatchQueue.main.async { ClanVoip.shared.end(id) } }
    Function("handle") { (_: String) -> String in "ios-uses-pushkit" }
    Function("bundleId") { () -> String? in Bundle.main.bundleIdentifier }
  }
}
