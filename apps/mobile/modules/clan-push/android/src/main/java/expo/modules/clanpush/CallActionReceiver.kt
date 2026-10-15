package expo.modules.clanpush

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/** Decline from the ringing notification: stop ringing now; CLAN tells the caller the next time it runs. */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: return
    NotificationManagerCompat.from(ctx).cancel(ClanWake.callNotificationId(id))
    val p = ClanWake.prefs(ctx); val a = JSONArray(p.getString("events", "[]"))
    a.put(JSONObject().put("k", "call").put("id", id).put("c", intent.getStringExtra("c") ?: "").put("action", "decline"))
    p.edit().putString("events", a.toString()).apply()
  }
}
