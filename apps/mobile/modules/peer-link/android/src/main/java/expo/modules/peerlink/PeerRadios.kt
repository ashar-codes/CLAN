// How Android phones find and reach each other for clan-link/1 without a router:
//  * NSD (DNS-SD) on whatever Wi-Fi the phone is on — a router, a phone's hotspot, a computer's CLAN Direct network
//  * Wi-Fi Direct: P2P DNS-SD service discovery, then a P2P group (the OS asks the other person to accept)
//  * Wi-Fi Aware (NAN, Android 8+ hardware that has it): publish/subscribe, then a secured NAN data path (IPv6)
//  * Local-only hotspot (Android 8+): a temporary network without internet that others join with its QR code
// Adverts carry only a random id (`r`) and the link port. Who someone is, is proved later by the link handshake.
package expo.modules.peerlink

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet6Address
import java.util.concurrent.ConcurrentHashMap

const val SERVICE_TYPE = "_clanlink._tcp"
private val R_RE = Regex("^[A-Za-z0-9_-]{8,24}$")
private val T_RE = Regex("^[A-Za-z0-9_-]{16}$")

@SuppressLint("MissingPermission") // JS requests NEARBY_WIFI_DEVICES / location first; failures surface as errors
class PeerRadios(private val ctx: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val cm get() = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  fun capabilities(): Map<String, Any?> {
    val pm = ctx.packageManager
    val aware = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && pm.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
    val awareAvailable = aware && (ctx.getSystemService(Context.WIFI_AWARE_SERVICE) as WifiAwareManager?)?.isAvailable == true
    return mapOf(
      "platform" to "android", "sdk" to Build.VERSION.SDK_INT,
      "tcp" to true, "nsd" to true,
      "wifiDirect" to pm.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT),
      "wifiAware" to aware, "wifiAwareAvailable" to awareAvailable,
      "localHotspot" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O),
      "joinWifi" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
      "applePeerToPeer" to false,
    )
  }

  /** This phone's IPv4 addresses on Wi-Fi / hotspot / Wi-Fi Direct interfaces (for the link addresses in its QR). */
  fun addresses(): List<String> = java.net.NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    .filter { it.isUp && !it.isLoopback && (it.name.startsWith("wlan") || it.name.startsWith("p2p") || it.name.startsWith("ap") || it.name.startsWith("swlan") || it.name.startsWith("eth")) }
    .flatMap { i -> i.inetAddresses.toList().filterIsInstance<java.net.Inet4Address>().map { it.hostAddress ?: "" } }
    .filter { it.isNotEmpty() }.distinct().take(4)

  // ---------------- NSD on the current Wi-Fi ----------------
  private val nsd get() = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
  private var nsdReg: NsdManager.RegistrationListener? = null
  private var nsdDisc: NsdManager.DiscoveryListener? = null
  private val resolveQueue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false
  private var nsdGeneration = 0

  fun nsdAdvertise(r: String, t: String, port: Int) {
    require(R_RE.matches(r) && (t.isEmpty() || T_RE.matches(t))) { "bad id" }
    nsdStopAdvertise()
    val info = NsdServiceInfo().apply { serviceName = "clan-${r.take(8)}"; serviceType = SERVICE_TYPE; setPort(port); setAttribute("r", r); if (t.isNotEmpty()) setAttribute("t", t); setAttribute("v", "1") }
    val l = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(i: NsdServiceInfo) {}
      override fun onRegistrationFailed(i: NsdServiceInfo, code: Int) { emit("radio", mapOf("type" to "error", "via" to "nsd", "message" to "advertise failed ($code)")) }
      override fun onServiceUnregistered(i: NsdServiceInfo) {}
      override fun onUnregistrationFailed(i: NsdServiceInfo, code: Int) {}
    }
    nsdReg = l
    nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
  }
  fun nsdStopAdvertise() { nsdReg?.let { runCatching { nsd.unregisterService(it) } }; nsdReg = null }

  fun nsdBrowse() {
    nsdStopBrowse()
    val generation = nsdGeneration
    val l = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(t: String) {}
      override fun onDiscoveryStopped(t: String) {}
      override fun onStartDiscoveryFailed(t: String, code: Int) { emit("radio", mapOf("type" to "error", "via" to "nsd", "message" to "browse failed ($code)")) }
      override fun onStopDiscoveryFailed(t: String, code: Int) {}
      override fun onServiceFound(i: NsdServiceInfo) { if (i.serviceName.startsWith("clan-")) main.post { if (generation == nsdGeneration && resolveQueue.size < 64) { resolveQueue.add(i); nextResolve() } } }
      override fun onServiceLost(i: NsdServiceInfo) { if (generation == nsdGeneration) emit("radio", mapOf("type" to "lost", "via" to "nsd", "name" to i.serviceName)) }
    }
    nsdDisc = l
    nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
  }
  // one resolve at a time (older Android refuses concurrent resolves)
  @Suppress("DEPRECATION")
  private fun nextResolve() {
    if (resolving) return
    val i = resolveQueue.removeFirstOrNull() ?: return
    resolving = true
    val generation = nsdGeneration
    nsd.resolveService(i, object : NsdManager.ResolveListener {
      override fun onResolveFailed(s: NsdServiceInfo, code: Int) { main.post { if (generation == nsdGeneration) { resolving = false; nextResolve() } } }
      override fun onServiceResolved(s: NsdServiceInfo) {
        val r = s.attributes["r"]?.let { String(it) } ?: ""
        val t = s.attributes["t"]?.let { String(it) }?.takeIf { T_RE.matches(it) } ?: ""
        val host = s.host?.hostAddress
        if (generation == nsdGeneration && host != null && R_RE.matches(r)) emit("radio", mapOf("type" to "found", "via" to "nsd", "r" to r, "t" to t, "host" to host, "port" to s.port, "name" to s.serviceName))
        main.post { if (generation == nsdGeneration) { resolving = false; nextResolve() } }
      }
    })
  }
  fun nsdStopBrowse() { nsdGeneration++; resolving = false; nsdDisc?.let { runCatching { nsd.stopServiceDiscovery(it) } }; nsdDisc = null; resolveQueue.clear() }

  // ---------------- Wi-Fi Direct ----------------
  private var p2p: WifiP2pManager? = null
  private var channel: WifiP2pManager.Channel? = null
  private var p2pReceiver: BroadcastReceiver? = null
  private var p2pService: WifiP2pDnsSdServiceInfo? = null

  private fun p2pReady(): Pair<WifiP2pManager, WifiP2pManager.Channel> {
    val m = p2p ?: (ctx.getSystemService(Context.WIFI_P2P_SERVICE) as WifiP2pManager?)?.also { p2p = it } ?: throw IllegalStateException("Wi-Fi Direct is not available on this phone.")
    val c = channel ?: m.initialize(ctx, Looper.getMainLooper(), null).also { channel = it }
    if (p2pReceiver == null) {
      val rcv = object : BroadcastReceiver() {
        override fun onReceive(c0: Context, i: Intent) {
          when (i.action) {
            WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> emit("radio", mapOf("type" to "state", "via" to "p2p", "enabled" to (i.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, 0) == WifiP2pManager.WIFI_P2P_STATE_ENABLED)))
            WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> m.requestConnectionInfo(c) { info: WifiP2pInfo? ->
              if (info != null && info.groupFormed) emit("radio", mapOf("type" to "connected", "via" to "p2p", "owner" to info.isGroupOwner, "host" to info.groupOwnerAddress?.hostAddress))
              else emit("radio", mapOf("type" to "disconnected", "via" to "p2p"))
            }
          }
        }
      }
      val f = IntentFilter().apply { addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION); addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION) }
      if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(rcv, f, Context.RECEIVER_NOT_EXPORTED) else ctx.registerReceiver(rcv, f)
      p2pReceiver = rcv
    }
    return m to c
  }
  private fun listener(what: String, done: ((String?) -> Unit)? = null) = object : WifiP2pManager.ActionListener {
    override fun onSuccess() { done?.invoke(null) }
    override fun onFailure(reason: Int) {
      val m = when (reason) { WifiP2pManager.P2P_UNSUPPORTED -> "Wi-Fi Direct is not supported."; WifiP2pManager.BUSY -> "Wi-Fi Direct is busy; try again."; else -> "Wi-Fi Direct $what failed ($reason)." }
      if (done != null) done(m) else emit("radio", mapOf("type" to "error", "via" to "p2p", "message" to m))
    }
  }

  /** Offer our link listener on Wi-Fi Direct and look for others doing the same. */
  fun p2pStart(r: String, t: String, port: Int, done: (String?) -> Unit) {
    require(R_RE.matches(r) && (t.isEmpty() || T_RE.matches(t))) { "bad id" }
    val (m, c) = p2pReady()
    p2pService?.let { m.removeLocalService(c, it, null) }
    val svc = WifiP2pDnsSdServiceInfo.newInstance("clan-${r.take(8)}", SERVICE_TYPE, mapOf("r" to r, "t" to t, "p" to port.toString(), "v" to "1"))
    p2pService = svc
    m.setDnsSdResponseListeners(c, { _, _, _ -> }, { domain, record, device ->
      val rr = record["r"] ?: ""
      val pp = record["p"]?.toIntOrNull() ?: 0
      val tt = record["t"]?.takeIf { T_RE.matches(it) } ?: ""
      if (domain.contains(SERVICE_TYPE) && R_RE.matches(rr) && pp in 1..65535) emit("radio", mapOf("type" to "found", "via" to "p2p", "r" to rr, "t" to tt, "port" to pp, "device" to device.deviceAddress))
    })
    m.addLocalService(c, svc, listener("advertise") { err ->
      if (err != null) return@listener done(err)
      m.clearServiceRequests(c, listener("reset"))
      m.addServiceRequest(c, WifiP2pDnsSdServiceRequest.newInstance(), listener("request") { e2 ->
        if (e2 != null) return@listener done(e2)
        m.discoverServices(c, listener("discovery", done))
      })
    })
  }
  /** Ask the OS to form a group with that device (the other person sees a system prompt to accept). */
  fun p2pConnect(device: String, done: (String?) -> Unit) {
    require(Regex("^[0-9a-fA-F:]{17}$").matches(device)) { "bad device" }
    val (m, c) = p2pReady()
    m.connect(c, WifiP2pConfig().apply { deviceAddress = device }, listener("connect", done))
  }
  fun p2pDisconnect() { val m = p2p ?: return; val c = channel ?: return; m.removeGroup(c, listener("disconnect") {}) }
  fun p2pStop() {
    val m = p2p; val c = channel
    if (m != null && c != null) { p2pService?.let { m.removeLocalService(c, it, null) }; m.clearServiceRequests(c, null); m.stopPeerDiscovery(c, null) }
    p2pService = null
    p2pReceiver?.let { runCatching { ctx.unregisterReceiver(it) } }; p2pReceiver = null
  }

  // ---------------- Wi-Fi Aware ----------------
  private var aware: WifiAwareSession? = null
  private var pub: PublishDiscoverySession? = null
  private var sub: SubscribeDiscoverySession? = null
  private val awarePeers = ConcurrentHashMap<String, Pair<PeerHandle, String>>() // id -> (handle, their r)
  private val awareNets = ConcurrentHashMap<String, Network>()
  private val awareCallbacks = ConcurrentHashMap<String, ConnectivityManager.NetworkCallback>()
  private var awareSeq = 0
  private var awareR = ""
  private var awarePort = 0
  private val awareService = "clanlink"
  private fun passFor(r: String) = "clan-link-$r" // not a secret: the NAN data path must be secured to carry the port; the link handshake protects the session

  private var awareT = ""
  fun awareStart(r: String, t: String, port: Int, done: (String?) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return done("Wi-Fi Aware data paths need Android 10 or newer.")
    val wam = ctx.getSystemService(Context.WIFI_AWARE_SERVICE) as WifiAwareManager? ?: return done("Wi-Fi Aware is not supported on this phone.")
    if (!wam.isAvailable) return done("Wi-Fi Aware is off or unavailable right now (turn on Wi-Fi and location if asked).")
    require(R_RE.matches(r) && (t.isEmpty() || T_RE.matches(t))) { "bad id" }
    awareR = r; awareT = t; awarePort = port
    wam.attach(object : AttachCallback() {
      override fun onAttachFailed() { done("Wi-Fi Aware could not start.") }
      override fun onAttached(session: WifiAwareSession) {
        aware = session
        session.publish(PublishConfig.Builder().setServiceName(awareService).setServiceSpecificInfo("$r.$t".toByteArray()).build(), object : DiscoverySessionCallback() {
          override fun onPublishStarted(s: PublishDiscoverySession) { pub = s }
          override fun onMessageReceived(peer: PeerHandle, message: ByteArray) {
            // a subscriber asked for a data path: offer one, carrying our link port
            val s = pub ?: return
            val theirR = String(message).removePrefix("c:")
            if (!R_RE.matches(theirR)) return
            request("pub-${theirR}", WifiAwareNetworkSpecifier.Builder(s, peer).setPskPassphrase(passFor(awareR)).setPort(awarePort).setTransportProtocol(6).build(), null)
          }
        }, main)
        session.subscribe(SubscribeConfig.Builder().setServiceName(awareService).build(), object : DiscoverySessionCallback() {
          override fun onSubscribeStarted(s: SubscribeDiscoverySession) { sub = s; done(null) }
          override fun onServiceDiscovered(peer: PeerHandle, info: ByteArray, filter: List<ByteArray>) {
            val parts = String(info).split('.', limit = 2)
            val theirR = parts[0]; val theirT = parts.getOrNull(1)?.takeIf { T_RE.matches(it) } ?: ""
            if (!R_RE.matches(theirR) || theirR == awareR) return
            val id = "a${++awareSeq}"
            awarePeers[id] = peer to theirR
            emit("radio", mapOf("type" to "found", "via" to "aware", "peer" to id, "r" to theirR, "t" to theirT))
          }
        }, main)
      }
    }, main)
  }
  /** Open a NAN data path to a discovered publisher; resolves through a `connected` event with its IPv6 address and port. */
  fun awareConnect(id: String, done: (String?) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return done("Needs Android 10 or newer.")
    val s = sub ?: return done("Wi-Fi Aware is not running.")
    val (peer, theirR) = awarePeers[id] ?: return done("That person is no longer nearby.")
    s.sendMessage(peer, ++awareSeq, "c:$awareR".toByteArray())
    request(id, WifiAwareNetworkSpecifier.Builder(s, peer).setPskPassphrase(passFor(theirR)).build(), done)
  }
  private fun request(id: String, spec: WifiAwareNetworkSpecifier, done: ((String?) -> Unit)?) {
    awareCallbacks.remove(id)?.let { runCatching { cm.unregisterNetworkCallback(it) } }
    val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE).setNetworkSpecifier(spec).build()
    var settled = false
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) { awareNets[id] = network }
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        val info = caps.transportInfo as? WifiAwareNetworkInfo ?: return
        val addr = info.peerIpv6Addr as? Inet6Address ?: return
        awareNets[id] = network
        if (done != null && info.port > 0 && !settled) {
          settled = true
          emit("radio", mapOf("type" to "connected", "via" to "aware", "peer" to id, "host" to addr.hostAddress, "port" to info.port, "net" to id))
          done(null)
        }
      }
      override fun onUnavailable() { if (!settled) { settled = true; done?.invoke("The Wi-Fi Aware connection was not established.") } }
      override fun onLost(network: Network) { awareNets.remove(id); emit("radio", mapOf("type" to "disconnected", "via" to "aware", "peer" to id)) }
    }
    awareCallbacks[id] = cb
    cm.requestNetwork(req, cb, 30_000)
  }
  fun awareNetwork(id: String): Network? = awareNets[id]
  fun awareStop() {
    for (cb in awareCallbacks.values) runCatching { cm.unregisterNetworkCallback(cb) }
    awareCallbacks.clear(); awareNets.clear(); awarePeers.clear()
    pub?.close(); sub?.close(); aware?.close(); pub = null; sub = null; aware = null
  }

  // ---------------- local-only hotspot and joining one ----------------
  private var reservation: WifiManager.LocalOnlyHotspotReservation? = null
  @Suppress("DEPRECATION")
  fun hotspotStart(done: (Map<String, Any?>?, String?) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return done(null, "Needs Android 8 or newer.")
    val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    reservation?.let { return done(describe(it), null) }
    wm.startLocalOnlyHotspot(object : WifiManager.LocalOnlyHotspotCallback() {
      override fun onStarted(r: WifiManager.LocalOnlyHotspotReservation) { reservation = r; done(describe(r), null) }
      override fun onStopped() { reservation = null; emit("radio", mapOf("type" to "hotspotStopped", "via" to "hotspot")) }
      override fun onFailed(reason: Int) { done(null, if (reason == ERROR_INCOMPATIBLE_MODE) "Turn off your regular hotspot first." else if (reason == ERROR_TETHERING_DISALLOWED) "Hotspots are not allowed on this phone." else "The hotspot could not start ($reason).") }
    }, main)
  }
  @Suppress("DEPRECATION")
  private fun describe(r: WifiManager.LocalOnlyHotspotReservation): Map<String, Any?> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val c = r.softApConfiguration
      val ssid = if (Build.VERSION.SDK_INT >= 33) c.wifiSsid?.toString()?.removeSurrounding("\"") else c.ssid
      mapOf("ssid" to ssid, "passphrase" to c.passphrase)
    } else { val c = r.wifiConfiguration; mapOf("ssid" to c?.SSID?.removeSurrounding("\""), "passphrase" to c?.preSharedKey?.removeSurrounding("\"")) }
  fun hotspotStop() { reservation?.close(); reservation = null }

  private var joinCb: ConnectivityManager.NetworkCallback? = null
  /** Join a nearby hotspot (system confirmation); traffic to it goes over that network. Android 10+. */
  fun joinWifi(ssid: String, passphrase: String, done: (String?) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return done("MANUAL")
    if (ssid.isEmpty() || ssid.toByteArray().size > 32 || passphrase.length !in 8..63) return done("Invalid network details.")
    leaveWifi()
    val spec = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(passphrase).build()
    val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).setNetworkSpecifier(spec).build()
    var settled = false
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) { cm.bindProcessToNetwork(network); if (!settled) { settled = true; done(null) } }
      override fun onUnavailable() { if (!settled) { settled = true; done("DENIED") } }
      override fun onLost(network: Network) { cm.bindProcessToNetwork(null); emit("radio", mapOf("type" to "disconnected", "via" to "hotspot")) }
    }
    joinCb = cb
    cm.requestNetwork(req, cb, 60_000)
  }
  fun leaveWifi() { joinCb?.let { runCatching { cm.unregisterNetworkCallback(it) } }; joinCb = null; cm.bindProcessToNetwork(null) }

  fun stopAll() { nsdStopAdvertise(); nsdStopBrowse(); p2pStop(); awareStop(); hotspotStop() }
}
