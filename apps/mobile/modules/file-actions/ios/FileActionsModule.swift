// Verified Photos export (add-only permission) and clipboard. Files: the system share sheet ("Save to Files").
import ExpoModulesCore
import Photos
import CryptoKit
import UIKit

public class FileActionsModule: Module {
  private func source(_ uri: String) throws -> URL {
    guard let u = URL(string: uri), u.isFileURL else { throw Exception(name: "ERR_SOURCE", description: "Only private downloaded files are allowed.") }
    let f = u.standardizedFileURL.resolvingSymlinksInPath()
    let roots = [FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0], FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0], FileManager.default.temporaryDirectory]
      .map { $0.standardizedFileURL.resolvingSymlinksInPath().path + "/" }
    guard roots.contains(where: { f.path.hasPrefix($0) }) else { throw Exception(name: "ERR_SOURCE", description: "File is outside private storage.") }
    return f
  }
  private func sha256(_ url: URL) throws -> String {
    let h = try FileHandle(forReadingFrom: url); defer { try? h.close() }
    var d = SHA256()
    while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty { d.update(data: chunk) }
    return d.finalize().map { String(format: "%02x", $0) }.joined()
  }
  public func definition() -> ModuleDefinition {
    Name("ClanFileActions")
    AsyncFunction("copyText") { (text: String) in
      DispatchQueue.main.async { UIPasteboard.general.string = String(text.prefix(8000)) }
    }
    AsyncFunction("saveToGallery") { (uri: String, expected: String, mime: String, name: String, promise: Promise) in
      do {
        let f = try self.source(uri)
        guard mime.hasPrefix("image/") || mime.hasPrefix("video/") else { throw Exception(name: "ERR_KIND", description: "Only photos and videos go to Photos.") }
        guard try self.sha256(f) == expected else { throw Exception(name: "ERR_HASH", description: "File changed after download.") }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
          guard status == .authorized || status == .limited else { promise.reject("ERR_PERMISSION", "Allow CLAN to add to Photos in Settings."); return }
          PHPhotoLibrary.shared().performChanges({
            let r = PHAssetCreationRequest.forAsset()
            let o = PHAssetResourceCreationOptions(); o.originalFilename = name
            r.addResource(with: mime.hasPrefix("video/") ? .video : .photo, fileURL: f, options: o)
          }) { ok, err in ok ? promise.resolve("photos") : promise.reject("ERR_SAVE", err?.localizedDescription ?? "Photos refused the file.") }
        }
      } catch { promise.reject(error) }
    }
  }
}
