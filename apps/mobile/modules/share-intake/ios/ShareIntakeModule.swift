// CLAN Share-to-CLAN (iOS app side). The Share Extension (ios-extension/ShareViewController.swift) copies what was
// shared into the app group container under share-in/<id>/ with a manifest, then opens clan://share?id=<id>. Here we
// move those files into the app's own temporary folder and hand them to JS once. NOT compiled here (needs Xcode).
import ExpoModulesCore
import Foundation

private let group = Bundle.main.object(forInfoDictionaryKey: "CLANShareGroup") as? String ?? "group.app.classroomlan.student"
private let maxBytes: Int64 = 200 * 1024 * 1024

public class ShareIntakeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShareIntake")
    Events("share")

    // No id: the oldest waiting hand-off (the extension can't open the app; CLAN checks when it comes to the foreground).
    AsyncFunction("take") { (requested: String?) -> [String: Any]? in
      guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("share-in", isDirectory: true) else { return nil }
      let waiting = ((try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: [.creationDateKey])) ?? [])
        .filter { UUID(uuidString: $0.lastPathComponent) != nil }
        .sorted { ((try? $0.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast) }
      guard let id = requested ?? waiting.first?.lastPathComponent, UUID(uuidString: id) != nil else { return nil }
      let root = base.appendingPathComponent(id, isDirectory: true)
      guard
            let data = try? Data(contentsOf: root.appendingPathComponent("manifest.json")),
            let m = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
      defer { try? FileManager.default.removeItem(at: root) } // each share is handed out once
      let dest = FileManager.default.temporaryDirectory.appendingPathComponent("share-in", isDirectory: true)
      try? FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
      var files: [[String: Any]] = []; var errors = (m["errors"] as? [String]) ?? []
      for f in ((m["files"] as? [[String: Any]]) ?? []).prefix(10) {
        guard let file = f["file"] as? String, !file.contains("/"), let name = f["name"] as? String else { continue }
        let src = root.appendingPathComponent(file), size = ((try? FileManager.default.attributesOfItem(atPath: src.path)[.size]) as? NSNumber)?.int64Value ?? 0
        if size > maxBytes { errors.append("\(name) is over 200 MB."); continue }
        let to = dest.appendingPathComponent("\(UUID().uuidString)-\(file)")
        do { try FileManager.default.moveItem(at: src, to: to) } catch { errors.append("Couldn't read \(name)."); continue }
        files.append(["uri": to.absoluteString, "name": name, "mime": (f["mime"] as? String) ?? "application/octet-stream", "size": Double(size)])
      }
      return ["text": (m["text"] as? String).map { String($0.prefix(20_000)) } as Any, "subject": NSNull(), "files": files, "errors": errors]
    }

    Function("discard") { (uris: [String]) in
      for u in uris { if let url = URL(string: u), url.deletingLastPathComponent().lastPathComponent == "share-in" { try? FileManager.default.removeItem(at: url) } }
    }
  }
}
