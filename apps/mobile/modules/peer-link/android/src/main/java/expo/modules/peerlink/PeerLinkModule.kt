// Expo surface of the Android peer transport: sockets for clan-link/1 plus the radios that find and connect phones
// without a router. Every connection it opens is anonymous until the link handshake (in JS) proves who is there.
package expo.modules.peerlink

import android.content.Context
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class PeerLinkModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw IllegalStateException("No context")
  private var ring: Ringtone? = null
  private val io = Executors.newCachedThreadPool()
  private val sockets by lazy { PeerSockets { e -> sendEvent("socket", e) } }
  private val radios by lazy { PeerRadios(ctx.applicationContext) { name, e -> sendEvent(name, e) } }

  override fun definition() = ModuleDefinition {
    Name("PeerLink")
    Events("socket", "radio", "availability", "availabilityTick")

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
      PeerLinkService.onPulse = { changed -> sendEvent("availabilityTick", mapOf("networkChanged" to changed)) }
      PeerLinkService.start(ctx, text)
    }
    Function("availabilityMicrophone") { active: Boolean -> PeerLinkService.microphone(ctx, active) }
    Function("ring") { active: Boolean ->
      ring?.stop(); ring = null
      if (active) { ring = RingtoneManager.getRingtone(ctx, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)); if (Build.VERSION.SDK_INT >= 28) ring?.isLooping = true; ring?.play() }
    }
    Function("availabilityStop") { PeerLinkService.stop(ctx) }
    Function("availabilityRunning") { PeerLinkService.running }
    Function("availabilityHealth") {
      val power = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
      val activity = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
      mapOf("running" to PeerLinkService.running, "batteryOptimized" to !power.isIgnoringBatteryOptimizations(ctx.packageName), "backgroundRestricted" to (Build.VERSION.SDK_INT >= 28 && activity.isBackgroundRestricted))
    }

    OnDestroy {
      ring?.stop(); ring = null; PeerLinkService.onPulse = null; PeerLinkService.onStopRequested = null; PeerLinkService.stop(ctx); sockets.closeAll(); radios.stopAll(); io.shutdown() }
  }
}
