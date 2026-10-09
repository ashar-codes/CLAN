// CLAN Share Extension (iOS): "Share → CLAN" from any app. Copies what was shared (link, text, image, file) into the app
// group container under share-in/<id>/ with a manifest; CLAN picks it up the next time it comes to the foreground and
// asks where to file it (Inbox first, offline). Limits: 10 items, 200 MB each, safe file names. Nothing is published.
// NOT compiled here (needs Xcode + an Apple team for the app group) — see docs/MOBILE.md.
import UIKit
import UniformTypeIdentifiers

private let group = "group.app.classroomlan.student"
private let maxBytes: Int64 = 200 * 1024 * 1024

final class ShareViewController: UIViewController {
  private let label = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 0.97, green: 0.95, blue: 0.90, alpha: 1)
    label.text = "Saving to CLAN…"; label.font = .preferredFont(forTextStyle: .title2); label.adjustsFontForContentSizeCategory = true
    label.numberOfLines = 0; label.textAlignment = .center; label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: view.centerXAnchor), label.centerYAnchor.constraint(equalTo: view.centerYAnchor), label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -40)])
    Task { await save() }
  }

  private func safe(_ n: String) -> String {
    let s = n.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)).joined(separator: "_")
    return String((s.isEmpty ? "shared" : s).prefix(120))
  }

  private func save() async {
    guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return finish("CLAN isn't set up for sharing on this device.") }
    let id = UUID().uuidString, dir = root.appendingPathComponent("share-in/\(id)", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var text: [String] = [], files: [[String: Any]] = [], errors: [String] = []
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    for p in providers.prefix(10) {
      if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, !u.isFileURL {
        text.append(u.absoluteString); continue
      }
      if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let t = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
        text.append(String(t.prefix(20_000))); continue
      }
      let type = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.data.identifier
      let name = safe(p.suggestedName ?? "shared")
      let ok: Bool = await withCheckedContinuation { c in
        _ = p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
          guard let url = url, let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, Int64(size) <= maxBytes else { c.resume(returning: false); return }
          let file = "\(files.count)-\(name)"
          do { try FileManager.default.copyItem(at: url, to: dir.appendingPathComponent(file)); files.append(["file": file, "name": name, "mime": UTType(type)?.preferredMIMEType ?? "application/octet-stream"]); c.resume(returning: true) }
          catch { c.resume(returning: false) }
        }
      }
      if !ok { errors.append("\(name) couldn't be saved (over 200 MB or unreadable).") }
    }
    if providers.count > 10 { errors.append("Only the first 10 items were taken.") }
    let manifest: [String: Any] = ["text": text.joined(separator: "\n"), "files": files, "errors": errors]
    guard let data = try? JSONSerialization.data(withJSONObject: manifest) else { return finish("Couldn't save.") }
    try? data.write(to: dir.appendingPathComponent("manifest.json"), options: .completeFileProtection)
    finish(files.isEmpty && text.isEmpty ? "Nothing CLAN can save was shared." : "Saved. Open CLAN to choose where it goes.")
  }

  private func finish(_ message: String) {
    DispatchQueue.main.async {
      self.label.text = message
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.extensionContext?.completeRequest(returningItems: nil) }
    }
  }
}
