// Native half of CLAN wake-ups (docs/FINAL_ANDROID_FCM.md). Runs without JavaScript: verify the per-friend MAC that only
// CLAN on this phone knows, drop duplicates/expired events, then post an ordinary notification. Content never arrives
// here; tapping opens CLAN, which connects to that friend over the local network to fetch the real (signed) data.
package expo.modules.clanpush

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ClanWake {
  const val MESSAGES = "clan-messages"; const val CALLS = "clan-calls-v1"; const val MISSED = "clan-missed"
  private const val MAX_TTL_MS = 24 * 3_600_000L + 120_000L
  fun prefs(ctx: Context) = ctx.getSharedPreferences("clan_push", Context.MODE_PRIVATE)

  data class Event(val k: String, val id: String, val exp: Long, val c: String, val m: String)
  data class Friend(val name: String, val convId: String?, val mac: String)

  fun parse(json: String?): Event? = try {
    val o = JSONObject(json ?: return null)
    Event(o.getString("k"), o.getString("id"), o.getLong("exp"), o.getString("c"), o.getString("m")).takeIf {
      it.k in setOf("msg", "file", "call", "call.cancel", "missed", "meeting") && it.id.matches(Regex("[0-9a-f-]{36}")) && it.c.matches(Regex("[A-Za-z0-9_-]{22}"))
    }
  } catch (_: Exception) { null }

  private fun friend(ctx: Context, capId: String): Friend? {
    val arr = JSONArray(prefs(ctx).getString("keys", "[]"))
    for (i in 0 until arr.length()) { val o = arr.getJSONObject(i); if (o.getString("capId") == capId) return Friend(o.getString("name"), o.optString("convId").ifEmpty { null }, o.getString("mac")) }
    return null
  }
  private fun b64(s: String) = Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  fun valid(f: Friend, e: Event, now: Long): Boolean {
    if (e.exp <= now || e.exp > now + MAX_TTL_MS) return false
    val mac = Mac.getInstance("HmacSHA256"); mac.init(SecretKeySpec(b64(f.mac), "HmacSHA256"))
    val want = mac.doFinal("clan-push-ev/v1|${e.k}|${e.id}|${e.exp}|${e.c}".toByteArray()).copyOf(16)
    return java.security.MessageDigest.isEqual(want, runCatching { b64(e.m) }.getOrNull() ?: return false)
  }
  /** First sighting of (kind, id) on this phone, by any path (push or local network). */
  fun firstTime(ctx: Context, key: String): Boolean {
    val p = prefs(ctx); val seen = JSONArray(p.getString("shown", "[]"))
    for (i in 0 until seen.length()) if (seen.getString(i) == key) return false
    val next = JSONArray(); val start = maxOf(0, seen.length() - 199); for (i in start until seen.length()) next.put(seen.getString(i)); next.put(key)
    p.edit().putString("shown", next.toString()).apply(); return true
  }
  fun channels(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val nm = ctx.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply { description = "New messages and files from friends" })
    nm.createNotificationChannel(NotificationChannel(MISSED, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT))
    nm.createNotificationChannel(NotificationChannel(CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
      enableVibration(true); lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    })
  }
  private fun open(ctx: Context, e: Event, f: Friend, action: String, code: Int): PendingIntent {
    val i = (ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: Intent()).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      putExtra("clanPush", JSONObject().put("k", e.k).put("id", e.id).put("c", e.c).put("convId", f.convId ?: "").put("action", action).toString())
    }
    return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
  fun callNotificationId(id: String) = ("call:$id").hashCode()

  /** Entry point for every received wake-up. Returns what happened (for logs/tests). */
  fun handle(ctx: Context, raw: String?, now: Long = System.currentTimeMillis()): String {
    val e = parse(raw) ?: return "malformed"
    val f = friend(ctx, e.c) ?: return "unknown-friend"      // revoked, blocked, or not for us
    if (!valid(f, e, now)) return "invalid"                   // forged by relay/provider, or expired
    if (!firstTime(ctx, "${e.k}:${e.id}")) return "duplicate"
    channels(ctx)
    val nm = NotificationManagerCompat.from(ctx)
    if (!nm.areNotificationsEnabled()) return "notifications-off"
    val previews = prefs(ctx).getBoolean("previews", true)
    val who = if (previews) f.name else "A friend"
    val small = ctx.applicationInfo.icon
    try {
      when (e.k) {
        "call" -> {
          val left = e.exp - now; if (left < 2000) return "expired"
          val person = Person.Builder().setName(who).setImportant(true).build()
          val decline = PendingIntent.getBroadcast(ctx, callNotificationId(e.id), Intent(ctx, CallActionReceiver::class.java).putExtra("id", e.id).putExtra("c", e.c),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
          val answer = open(ctx, e, f, "answer", callNotificationId(e.id) + 1)
          nm.notify(callNotificationId(e.id), NotificationCompat.Builder(ctx, CALLS).setSmallIcon(small).setContentTitle(who).setContentText("Incoming CLAN call")
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer)).setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX).setOngoing(true).setAutoCancel(true).setTimeoutAfter(left)
            .setFullScreenIntent(open(ctx, e, f, "ring", callNotificationId(e.id) + 2), true).setContentIntent(open(ctx, e, f, "ring", callNotificationId(e.id) + 3)).build())
        }
        "call.cancel", "missed" -> {
          nm.cancel(callNotificationId(e.id))
          if (!firstTime(ctx, "missed-shown:${e.id}")) return "duplicate"
          nm.notify(("missed:${e.id}").hashCode(), NotificationCompat.Builder(ctx, MISSED).setSmallIcon(small).setContentTitle("Missed call").setContentText(who)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL).setAutoCancel(true).setContentIntent(open(ctx, e, f, "open", ("missed:${e.id}").hashCode())).build())
        }
        else -> {
          val text = when (e.k) { "file" -> "Sent you a file"; "meeting" -> "Meeting invitation"; else -> "New message" }
          nm.notify(("conv:${e.c}").hashCode(), NotificationCompat.Builder(ctx, MESSAGES).setSmallIcon(small).setContentTitle(who).setContentText("$text · open CLAN on the same network to receive it")
            .setCategory(NotificationCompat.CATEGORY_MESSAGE).setAutoCancel(true).setContentIntent(open(ctx, e, f, "open", ("conv:${e.c}").hashCode())).build())
        }
      }
    } catch (_: SecurityException) { return "notifications-denied" }
    return "shown"
  }
}
