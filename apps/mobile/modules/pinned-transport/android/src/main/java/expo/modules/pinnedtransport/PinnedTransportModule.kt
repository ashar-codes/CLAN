// CLAN pinned transport (Android). Compiled in the Android build and exercised on the emulator (docs/TESTING.md).
//
// Trust rule (the only one): the server chain must validate against a trust store containing ONLY the per-class CA
// from the OPAQUE-authenticated binding (no system or user CAs), AND the leaf SubjectPublicKeyInfo SHA-256 must equal
// the pin. Host names aren't checked (the pin is the identity; the leaf has no SAN), so the hostname verifier accepts
// any name for THIS client only. Never a trust-all manager.
package expo.modules.pinnedtransport

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.TlsVersion
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.BufferedSink
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.URI
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** Trusts only `ca` as root and then requires the leaf SPKI SHA-256 (standard base64) to equal `pin`. */
class PinnedTrustManager(private val ca: X509Certificate, private val pin: String) : X509TrustManager {
  private val base: X509TrustManager = run {
    val ks = KeyStore.getInstance(KeyStore.getDefaultType())
    ks.load(null, null)
    ks.setCertificateEntry("classroom-ca", ca)
    val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    tmf.init(ks)
    tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("client certificates are not used")

  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    base.checkServerTrusted(chain, authType) // chain must end at the classroom CA (the only anchor in the store)
    val spki = MessageDigest.getInstance("SHA-256").digest(chain[0].publicKey.encoded) // X.509 SPKI DER
    if (Base64.encodeToString(spki, Base64.NO_WRAP) != pin) throw CertificateException("classroom certificate pin mismatch")
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf(ca)
}

/** Personal-device linking only: no anchor yet, so the FIRST leaf key seen is pinned for the rest of this connection
 *  (the link proofs are bound to it — docs/SYNC.md). Never used for classroom or sync traffic. */
class FirstContactTrustManager : X509TrustManager {
  @Volatile var seen: String? = null
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("client certificates are not used")
  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    if (chain.isEmpty()) throw CertificateException("no certificate")
    chain[0].checkValidity()
    val spki = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(chain[0].publicKey.encoded), Base64.NO_WRAP)
    synchronized(this) { if (seen == null) seen = spki else if (seen != spki) throw CertificateException("the other device's key changed") }
  }
  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

class PinnedTransportModule : Module() {
  private val firstContact = ConcurrentHashMap<String, FirstContactTrustManager>()
  private val clients = ConcurrentHashMap<String, OkHttpClient>()
  private val calls = ConcurrentHashMap<String, Call>()
  private val sockets = ConcurrentHashMap<String, WebSocket>()

  private fun install(id: String, tm: X509TrustManager) {
    val ctx = SSLContext.getInstance("TLS").apply { init(null, arrayOf(tm), null) }
    val tls13 = ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS).tlsVersions(TlsVersion.TLS_1_3).build()
    clients[id] = OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .sslSocketFactory(ctx.socketFactory, tm)
      .hostnameVerifier { _, _ -> true } // identity = CA + SPKI pin (or first-contact pin), enforced by `tm`
      .connectionSpecs(listOf(tls13))
      .readTimeout(60, TimeUnit.SECONDS)
      .retryOnConnectionFailure(false)
      .build()
  }

  private fun client(id: String) = clients[id] ?: throw CodedException("NotConfigured", "Unknown pinned connection", null)

  private fun secureRequest(url: String, headers: Map<String, String>): Request.Builder {
    val scheme = URI(url).scheme
    if (scheme != "https" && scheme != "wss") throw CodedException("Insecure", "Only https/wss", null)
    return Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }
  }

  private fun path(uri: String) = if (uri.startsWith("file://")) URI(uri).path else uri

  override fun definition() = ModuleDefinition {
    Name("PinnedTransport")
    Events("progress", "wsOpen", "wsMessage", "wsClose")

    Function("configure") { id: String, caDerB64: String, pinB64: String ->
      val ca = CertificateFactory.getInstance("X.509")
        .generateCertificate(ByteArrayInputStream(Base64.decode(caDerB64, Base64.DEFAULT))) as X509Certificate
      install(id, PinnedTrustManager(ca, pinB64))
    }

    Function("configureFirstContact") { id: String -> val tm = FirstContactTrustManager(); firstContact[id] = tm; install(id, tm); Unit }
    Function("seenPin") { id: String -> val pin: String? = firstContact[id]?.seen; pin }

    Function("release") { id: String -> firstContact.remove(id); clients.remove(id)?.dispatcher?.cancelAll(); Unit }

    AsyncFunction("request") { id: String, method: String, url: String, headers: Map<String, String>, body: String?, promise: Promise ->
      val rb = body?.toRequestBody((headers["content-type"] ?: "application/json").toMediaTypeOrNull())
      val req = secureRequest(url, headers).method(method, rb).build()
      client(id).newCall(req).enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = promise.reject(CodedException("Network", e.message ?: "network error", e))
        override fun onResponse(call: Call, response: Response) = response.use {
          promise.resolve(mapOf("status" to it.code, "headers" to it.headers.toMultimap().mapValues { e -> e.value.joinToString(", ") }, "body" to (it.body?.string() ?: "")))
        }
      })
    }

    AsyncFunction("download") { id: String, reqId: String, url: String, headers: Map<String, String>, fileUri: String, append: Boolean, promise: Promise ->
      val call = client(id).newCall(secureRequest(url, headers).get().build())
      calls[reqId] = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { calls.remove(reqId); promise.reject(CodedException("Network", e.message ?: "network error", e)) }
        override fun onResponse(call: Call, response: Response) {
          try {
            response.use {
              val file = File(path(fileUri))
              if (it.code != 200 && it.code != 206) { promise.resolve(mapOf("status" to it.code, "bytes" to file.length())); return }
              val keep = append && it.code == 206 // a 200 means the server sent the whole file again
              FileOutputStream(file, keep).use { out ->
                var written = if (keep) file.length() else 0L
                val buf = ByteArray(64 * 1024)
                val input = it.body!!.byteStream()
                var last = 0L
                while (true) {
                  val n = input.read(buf)
                  if (n < 0) break
                  out.write(buf, 0, n)
                  written += n
                  val now = System.currentTimeMillis()
                  if (now - last > 250) { last = now; sendEvent("progress", mapOf("id" to reqId, "bytes" to written)) }
                }
                promise.resolve(mapOf("status" to it.code, "bytes" to written))
              }
            }
          } catch (e: IOException) {
            promise.reject(CodedException("Network", e.message ?: "network error", e))
          } finally { calls.remove(reqId) }
        }
      })
    }

    AsyncFunction("upload") { id: String, reqId: String, url: String, headers: Map<String, String>, fileUri: String, offset: Double, promise: Promise ->
      val file = File(path(fileUri))
      val start = offset.toLong()
      val body = object : RequestBody() {
        override fun contentType() = (headers["content-type"] ?: "application/offset+octet-stream").toMediaTypeOrNull()
        override fun contentLength() = file.length() - start
        override fun writeTo(sink: BufferedSink) {
          RandomAccessFile(file, "r").use { raf ->
            raf.seek(start)
            val buf = ByteArray(64 * 1024)
            var sent = start
            while (true) {
              val n = raf.read(buf)
              if (n < 0) break
              sink.write(buf, 0, n)
              sent += n
              sendEvent("progress", mapOf("id" to reqId, "bytes" to sent))
            }
          }
        }
      }
      val call = client(id).newCall(secureRequest(url, headers).put(body).build())
      calls[reqId] = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { calls.remove(reqId); promise.reject(CodedException("Network", e.message ?: "network error", e)) }
        override fun onResponse(call: Call, response: Response) { calls.remove(reqId); response.use { promise.resolve(mapOf("status" to it.code, "body" to (it.body?.string() ?: ""))) } }
      })
    }

    Function("cancel") { reqId: String -> calls.remove(reqId)?.cancel(); Unit }

    Function("wsOpen") { id: String, wsId: String, url: String ->
      sockets[wsId] = client(id).newWebSocket(secureRequest(url, emptyMap()).build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = sendEvent("wsOpen", mapOf("id" to wsId))
        override fun onMessage(webSocket: WebSocket, text: String) = sendEvent("wsMessage", mapOf("id" to wsId, "data" to text))
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = sendEvent("wsMessage", mapOf("id" to wsId, "binary" to bytes.base64()))
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { sockets.remove(wsId); sendEvent("wsClose", mapOf("id" to wsId, "code" to code, "reason" to reason)) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { sockets.remove(wsId); sendEvent("wsClose", mapOf("id" to wsId, "code" to 1006, "reason" to "")) }
      })
    }

    Function("wsSend") { wsId: String, text: String -> val ok: Boolean = sockets[wsId]?.send(text) ?: false; ok }
    Function("wsSendBinary") { wsId: String, b64: String -> val ok: Boolean = sockets[wsId]?.send(Base64.decode(b64, Base64.NO_WRAP).toByteString()) ?: false; ok }
    Function("wsClose") { wsId: String, code: Int, reason: String -> sockets.remove(wsId)?.close(code, reason); Unit }
  }
}
