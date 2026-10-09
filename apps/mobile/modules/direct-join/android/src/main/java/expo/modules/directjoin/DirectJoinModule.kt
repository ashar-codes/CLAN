// CLAN Direct join (Android): BLE bootstrap central + joining the host Wi-Fi with the authenticated credential.
// Compiled in the Android build; module load verified on the emulator (BLE/Wi-Fi joining needs real hardware).
// Wi-Fi uses WifiNetworkSpecifier (Android 10+, system confirmation dialog); the app process is bound to that network so
// the pinned HTTPS/WSS traffic goes over it. Older Android → manual fallback.
package expo.modules.directjoin

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.net.*
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

private val SERVICE = UUID.fromString("6f1a0001-7c3b-4d5e-9a2b-c1a4e5f60001")
private val RX = UUID.fromString("6f1a0002-7c3b-4d5e-9a2b-c1a4e5f60001")
private val TX = UUID.fromString("6f1a0003-7c3b-4d5e-9a2b-c1a4e5f60001")
private val CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
private val SSID_RE = Regex("^CLAN-[0-9A-Z]{4}$")
private val PASS_RE = Regex("^[A-Za-z0-9]{16,63}$")

@SuppressLint("MissingPermission") // permissions are requested from JS before any call; failures surface as errors
class DirectJoinModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw IllegalStateException("No context")
  private val main = Handler(Looper.getMainLooper())
  private val found = mutableMapOf<String, BluetoothDevice>()
  private val conns = mutableMapOf<String, Pair<BluetoothGatt, BluetoothGattCharacteristic>>()
  private var wifiCallback: ConnectivityManager.NetworkCallback? = null

  override fun definition() = ModuleDefinition {
    Name("DirectJoin")
    Events("bleFrame")

    Function("bluetoothState") {
      val a = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter
      val state: String = when { a == null -> "unsupported"; !a.isEnabled -> "off"; else -> "on" }
      state
    }

    AsyncFunction("joinWifi") { ssid: String, passphrase: String, promise: Promise ->
      if (!SSID_RE.matches(ssid) || !PASS_RE.matches(passphrase)) return@AsyncFunction promise.reject("WIFI", "Invalid network credential.", null)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@AsyncFunction promise.reject("MANUAL", "This Android version needs the network to be joined in Settings.", null)
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      wifiCallback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
      val spec = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(passphrase).build()
      val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).setNetworkSpecifier(spec).build()
      var settled = false
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { cm.bindProcessToNetwork(network); if (!settled) { settled = true; promise.resolve(null) } }
        override fun onUnavailable() { if (!settled) { settled = true; promise.reject("DENIED", "The CLAN network was not joined.", null) } }
        override fun onLost(network: Network) { cm.bindProcessToNetwork(null) }
      }
      wifiCallback = cb
      cm.requestNetwork(req, cb, 45_000)
      Unit // explicit: Expo reifies each lambda's result type
    }

    Function("leaveWifi") {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      wifiCallback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
      wifiCallback = null
      cm.bindProcessToNetwork(null)
      Unit
    }

    AsyncFunction("bleScan") { ms: Int, promise: Promise ->
      val scanner = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?)?.adapter?.bluetoothLeScanner
        ?: return@AsyncFunction promise.reject("BLE", "Bluetooth is off or unsupported.", null)
      found.clear()
      val cb = object : ScanCallback() {
        override fun onScanResult(t: Int, r: ScanResult) { found[r.device.address.replace(":", "").lowercase()] = r.device }
        override fun onScanFailed(code: Int) { promise.reject("BLE", "Bluetooth scan failed ($code).", null) }
      }
      val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE)).build()
      try { scanner.startScan(listOf(filter), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb) }
      catch (e: SecurityException) { return@AsyncFunction promise.reject("BLE", "Bluetooth permission denied.", e) }
      main.postDelayed({ runCatching { scanner.stopScan(cb) }; promise.resolve(found.keys.toList()) }, ms.coerceIn(500, 15_000).toLong())
      Unit
    }

    AsyncFunction("bleConnect") { peer: String, promise: Promise ->
      val dev = found[peer] ?: return@AsyncFunction promise.reject("BLE", "Host not found; scan again.", null)
      val conn = UUID.randomUUID().toString()
      var done = false
      dev.connectGatt(ctx, false, object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, state: Int) {
          if (state == BluetoothProfile.STATE_CONNECTED) g.discoverServices()
          else if (!done) { done = true; g.close(); promise.reject("BLE", "Bluetooth connection failed.", null) }
        }
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
          val s = g.getService(SERVICE); val rx = s?.getCharacteristic(RX); val tx = s?.getCharacteristic(TX)
          if (rx == null || tx == null) { done = true; g.close(); return promise.reject("BLE", "Not a CLAN host.", null) }
          g.setCharacteristicNotification(tx, true)
          val d = tx.getDescriptor(CCCD)
          if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
          else { @Suppress("DEPRECATION") run { d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; g.writeDescriptor(d) } }
          conns[conn] = g to rx
        }
        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
          if (!done) { done = true; promise.resolve(conn) }
        }
        @Deprecated("API < 33") override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
          @Suppress("DEPRECATION") emitFrame(conn, c.value)
        }
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) = emitFrame(conn, value)
      }, BluetoothDevice.TRANSPORT_LE)
      Unit
    }

    Function("bleWrite") { conn: String, frameB64: String ->
      val (g, rx) = conns[conn] ?: return@Function false
      val bytes = Base64.decode(frameB64, Base64.DEFAULT)
      if (bytes.size > 180) return@Function false
      val ok: Boolean = if (Build.VERSION.SDK_INT >= 33) g.writeCharacteristic(rx, bytes, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE) == BluetoothStatusCodes.SUCCESS
      else @Suppress("DEPRECATION") run { rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE; rx.value = bytes; g.writeCharacteristic(rx) }
      ok
    }

    Function("bleClose") { conn: String -> conns.remove(conn)?.first?.let { it.disconnect(); it.close() }; Unit }
  }

  private fun emitFrame(conn: String, v: ByteArray) {
    if (v.size <= 180) sendEvent("bleFrame", mapOf("conn" to conn, "frame" to Base64.encodeToString(v, Base64.NO_WRAP)))
  }
}
