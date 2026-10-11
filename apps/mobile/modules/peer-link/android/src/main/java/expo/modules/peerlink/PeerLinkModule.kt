// Expo surface of the Android peer transport: sockets for clan-link/1 plus the radios that find and connect phones
// without a router. Every connection it opens is anonymous until the link handshake (in JS) proves who is there.
package expo.modules.peerlink

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class PeerLinkModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw IllegalStateException("No context")
  private val io = Executors.newCachedThreadPool()
  private val sockets by lazy { PeerSockets { e -> sendEvent("socket", e) } }
  private val radios by lazy { PeerRadios(ctx.applicationContext) { name, e -> sendEvent(name, e) } }

  override fun definition() = ModuleDefinition {
    Name("PeerLink")
    Events("socket", "radio", "availability")

    Function("capabilities") { radios.capabilities() }

    // ---- sockets ----
    AsyncFunction("listen") { port: Int, promise: Promise -> io.execute { try { promise.resolve(sockets.listen(port)) } catch (e: Exception) { promise.reject("LISTEN", e.message ?: "Could not listen.", e) } } }
    Function("stopListening") { sockets.stopListening() }
    AsyncFunction("connect") { host: String, port: Int, net: String?, promise: Promise ->
      io.execute {
        try {
          val network = net?.let { radios.awareNetwork(it) ?: throw IllegalStateException("That direct connection is gone.") }
          promise.resolve(sockets.connect(host, port, network, 8000))
        } catch (e: Exception) { promise.reject("CONNECT", e.message ?: "Not reachable.", e) }
      }
    }
    Function("write") { id: String, b64: String -> sockets.write(id, b64) }
    Function("close") { id: String -> sockets.close(id) }

    // ---- discovery on the current Wi-Fi (router, hotspot, CLAN Direct network) ----
    Function("addresses") { radios.addresses() }
    Function("advertise") { r: String, t: String, port: Int -> radios.nsdAdvertise(r, t, port) }
    Function("stopAdvertise") { radios.nsdStopAdvertise() }
    Function("browse") { radios.nsdBrowse() }
    Function("stopBrowse") { radios.nsdStopBrowse() }

    // ---- Wi-Fi Direct ----
    AsyncFunction("p2pStart") { r: String, t: String, port: Int, promise: Promise -> radios.p2pStart(r, t, port) { err -> if (err == null) promise.resolve(null) else promise.reject("P2P", err, null) } }
    AsyncFunction("p2pConnect") { device: String, promise: Promise -> radios.p2pConnect(device) { err -> if (err == null) promise.resolve(null) else promise.reject("P2P", err, null) } }
    Function("p2pDisconnect") { radios.p2pDisconnect() }
    Function("p2pStop") { radios.p2pStop() }

    // ---- Wi-Fi Aware ----
    AsyncFunction("awareStart") { r: String, t: String, port: Int, promise: Promise -> radios.awareStart(r, t, port) { err -> if (err == null) promise.resolve(null) else promise.reject("AWARE", err, null) } }
    AsyncFunction("awareConnect") { peer: String, promise: Promise -> radios.awareConnect(peer) { err -> if (err == null) promise.resolve(null) else promise.reject("AWARE", err, null) } }
    Function("awareStop") { radios.awareStop() }

    // ---- hotspot ----
    AsyncFunction("hotspotStart") { promise: Promise -> radios.hotspotStart { cfg, err -> if (cfg != null) promise.resolve(cfg) else promise.reject("HOTSPOT", err ?: "failed", null) } }
    Function("hotspotStop") { radios.hotspotStop() }
    AsyncFunction("joinWifi") { ssid: String, passphrase: String, promise: Promise -> radios.joinWifi(ssid, passphrase) { err -> if (err == null) promise.resolve(null) else promise.reject(if (err == "MANUAL" || err == "DENIED") err else "WIFI", err, null) } }
    Function("leaveWifi") { radios.leaveWifi() }

    // ---- staying available during an active session (foreground service with a notification) ----
    Function("availabilityStart") { text: String ->
      PeerLinkService.onStopRequested = { sendEvent("availability", mapOf("running" to false, "byUser" to true)) }
      PeerLinkService.start(ctx, text)
    }
    Function("availabilityStop") { PeerLinkService.stop(ctx) }
    Function("availabilityRunning") { PeerLinkService.running }

    OnDestroy { sockets.closeAll(); radios.stopAll(); io.shutdown() }
  }
}
