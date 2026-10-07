// macOS harness: drives PinnedTrust (the exact iOS trust code) against a real Classroom LAN HTTPS server.
// Usage: pinned-trust-check <url> <caDerB64> <pinB64>   -> prints "ok <status>" or "rejected"
import Foundation
import Security

let args = CommandLine.arguments
guard args.count == 4, let der = Data(base64Encoded: args[2]), let ca = SecCertificateCreateWithData(nil, der as CFData) else { print("usage"); exit(2) }
let trust = PinnedTrust(anchor: ca, pin: args[3])
let cfg = URLSessionConfiguration.ephemeral
cfg.tlsMinimumSupportedProtocolVersion = .TLSv13
let session = URLSession(configuration: cfg, delegate: trust, delegateQueue: nil)
let done = DispatchSemaphore(value: 0)
session.dataTask(with: URL(string: args[1])!) { _, resp, err in
  if let r = resp as? HTTPURLResponse { print("ok \(r.statusCode)") } else { print("rejected \((err as NSError?)?.code ?? 0)") }
  done.signal()
}.resume()
done.wait()
