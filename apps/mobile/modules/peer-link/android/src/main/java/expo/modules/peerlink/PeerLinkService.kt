// Explicit opt-in availability, always visible and stoppable. Native retry pulses and a partial wake lock
// keep the in-process authenticated transport operational; Doze/OEM policies may still restrict the network.
// No automatic boot/start or sticky restart. Releasing Stop tears down the lock and all pulse callbacks.
package expo.modules.peerlink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.LinkProperties
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PeerLinkService : Service() {
  companion object {
    const val CHANNEL = "clan-nearby"
    const val ID = 4401
    const val STOP = "expo.modules.peerlink.STOP"
    @Volatile var running = false
    var onStopRequested: (() -> Unit)? = null
    var onPulse: ((Boolean) -> Unit)? = null

    fun start(ctx: Context, text: String) {
      val i = Intent(ctx, PeerLinkService::class.java).putExtra("text", text.take(120))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    }
    fun microphone(ctx: Context, active: Boolean) { if (running) ctx.startService(Intent(ctx, PeerLinkService::class.java).putExtra("microphone", active)) }
    fun stop(ctx: Context) { ctx.stopService(Intent(ctx, PeerLinkService::class.java)) }
  }

  private var recording = false
  private var wake: PowerManager.WakeLock? = null
  private var pulses: java.util.concurrent.ScheduledExecutorService? = null
  private val links = java.util.concurrent.ConcurrentHashMap<Network, String>()
  private val network = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(n: Network) { onPulse?.invoke(true) }
    override fun onLost(n: Network) { links.remove(n); onPulse?.invoke(true) }
    override fun onLinkPropertiesChanged(n: Network, p: LinkProperties) {
      val signature = p.linkAddresses.map { it.toString() }.sorted().joinToString(",") + "|" + p.routes.map { it.toString() }.sorted().joinToString(",")
      if (links.put(n, signature) != signature) onPulse?.invoke(true)
    }
  }
  private var networkRegistered = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) { onStopRequested?.invoke(); stopSelf(); return START_NOT_STICKY }
    if (intent?.hasExtra("microphone") == true) recording = intent.getBooleanExtra("microphone", false)
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null)
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Nearby connections", NotificationManager.IMPORTANCE_LOW).apply { description = "Shown while Keep CLAN Available is enabled. May increase battery use." })
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    val stop = PendingIntent.getService(this, 1, Intent(this, PeerLinkService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    @Suppress("DEPRECATION")
    val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    val n = b.setContentTitle("Keep CLAN Available is on")
      .setContentText(intent?.getStringExtra("text") ?: "Receiving local messages. Battery use may increase.")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or (if (recording) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)) else startForeground(ID, n)
    if (pulses == null) {
      wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CLAN:availability").apply { setReferenceCounted(false); acquire() }
      pulses = Executors.newSingleThreadScheduledExecutor().also { it.scheduleWithFixedDelay({ try { onPulse?.invoke(false) } catch (_: Exception) { } }, 0, 4, TimeUnit.SECONDS) }
      try { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(network); networkRegistered = true } catch (_: Exception) { }
    }
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    pulses?.shutdownNow(); pulses = null
    if (networkRegistered) { try { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(network) } catch (_: Exception) { }; networkRegistered = false }
    wake?.let { if (it.isHeld) it.release() }; wake = null
    running = false; super.onDestroy()
  }
}
