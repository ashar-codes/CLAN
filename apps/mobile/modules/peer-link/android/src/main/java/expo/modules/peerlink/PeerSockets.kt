// Plain TCP for clan-link/1 (the link handshake provides authentication and encryption, not the socket). One listener
// while people networking is on; client sockets may be bound to a specific Network (Wi-Fi Aware data path, a joined
// hotspot). Bytes cross to JS base64-encoded; each socket has one reader thread and one writer thread.
package expo.modules.peerlink

import android.net.Network
import android.util.Base64
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

class PeerSockets(private val emit: (Map<String, Any?>) -> Unit) {
  private class Conn(val socket: Socket, val out: OutputStream, val writer: ExecutorService)
  private val conns = ConcurrentHashMap<String, Conn>()
  private val seq = AtomicInteger()
  private var server: ServerSocket? = null
  private val maxConns = 32

  /** Listen on all interfaces (Wi-Fi, hotspot, Wi-Fi Direct group, Aware IPv6). Returns the bound port. */
  @Synchronized fun listen(port: Int): Int {
    server?.let { if (!it.isClosed) return it.localPort }
    val s = ServerSocket()
    s.reuseAddress = true
    s.bind(InetSocketAddress(port.coerceIn(0, 65535)))
    server = s
    Thread({
      while (!s.isClosed) {
        val c = try { s.accept() } catch (e: Exception) { break }
        if (conns.size >= maxConns) { runCatching { c.close() }; continue }
        adopt(c, "accepted")
      }
    }, "clan-link-accept").apply { isDaemon = true }.start()
    return s.localPort
  }
  @Synchronized fun stopListening() { runCatching { server?.close() }; server = null }

  /** Connect to host:port, optionally over a specific network (bound before connecting). */
  fun connect(host: String, port: Int, network: Network?, timeoutMs: Int): String {
    val socket = network?.socketFactory?.createSocket() ?: Socket()
    socket.connect(InetSocketAddress(host, port), timeoutMs)
    return adopt(socket, null)
  }

  private fun adopt(socket: Socket, announce: String?): String {
    val id = "s${seq.incrementAndGet()}"
    socket.tcpNoDelay = true
    socket.soTimeout = 0
    val conn = Conn(socket, socket.getOutputStream(), Executors.newSingleThreadExecutor())
    conns[id] = conn
    if (announce != null) emit(mapOf("id" to id, "type" to announce, "remote" to (socket.remoteSocketAddress?.toString() ?: "")))
    Thread({ read(id, socket.getInputStream()) }, "clan-link-read-$id").apply { isDaemon = true }.start()
    return id
  }

  private fun read(id: String, input: InputStream) {
    val buf = ByteArray(64 * 1024)
    try {
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        if (n > 0) emit(mapOf("id" to id, "type" to "data", "data" to Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)))
      }
    } catch (_: Exception) {
    } finally { close(id) }
  }

  fun write(id: String, b64: String): Boolean {
    val c = conns[id] ?: return false
    val bytes = try { Base64.decode(b64, Base64.NO_WRAP) } catch (_: IllegalArgumentException) { return false }
    c.writer.execute { try { c.out.write(bytes); c.out.flush() } catch (_: Exception) { close(id) } }
    return true
  }

  fun close(id: String) {
    val c = conns.remove(id) ?: return
    runCatching { c.socket.close() }
    c.writer.shutdown()
    emit(mapOf("id" to id, "type" to "closed"))
  }

  fun closeAll() { stopListening(); for (id in conns.keys.toList()) close(id) }
  fun count() = conns.size
}
