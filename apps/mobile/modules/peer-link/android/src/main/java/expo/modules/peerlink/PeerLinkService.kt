// "Stay available during an active session": a user-visible foreground service that keeps CLAN's nearby connections
// (and an ongoing call) alive while the screen is off or another app is in front. Started only by the person's choice
// for an active chat/call/transfer, always with a notification that says so and a Stop action; stopped as soon as the
// session ends. Never started at boot and never restarted by the system (START_NOT_STICKY).
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

class PeerLinkService : Service() {
  companion object {
    const val CHANNEL = "clan-nearby"
    const val ID = 4401
    const val STOP = "expo.modules.peerlink.STOP"
    @Volatile var running = false
    var onStopRequested: (() -> Unit)? = null

    fun start(ctx: Context, text: String) {
      val i = Intent(ctx, PeerLinkService::class.java).putExtra("text", text.take(120))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    }
    fun stop(ctx: Context) { ctx.stopService(Intent(ctx, PeerLinkService::class.java)) }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) { onStopRequested?.invoke(); stopSelf(); return START_NOT_STICKY }
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null)
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Nearby connections", NotificationManager.IMPORTANCE_LOW).apply { description = "Shown while CLAN keeps a nearby chat, call or transfer connected." })
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    val stop = PendingIntent.getService(this, 1, Intent(this, PeerLinkService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    @Suppress("DEPRECATION")
    val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    val n = b.setContentTitle("CLAN is connected to people nearby")
      .setContentText(intent?.getStringExtra("text") ?: "Keeping your nearby session open.")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE) else startForeground(ID, n)
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() { running = false; super.onDestroy() }
}
