package expo.modules.clanpush

import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray

class ClanPushModule : Module() {
  private fun ctx() = appContext.reactContext ?: error("No context")
  private fun take(intent: Intent?) {
    val raw = intent?.getStringExtra("clanPush") ?: return
    intent.removeExtra("clanPush")
    val p = ClanWake.prefs(ctx()); val a = JSONArray(p.getString("events", "[]")); a.put(org.json.JSONObject(raw)); p.edit().putString("events", a.toString()).apply()
    if (raw.contains("\"answer\"") || raw.contains("\"ring\"")) org.json.JSONObject(raw).optString("id").takeIf { it.isNotEmpty() }?.let { androidx.core.app.NotificationManagerCompat.from(ctx()).cancel(ClanWake.callNotificationId(it)) }
  }
  override fun definition() = ModuleDefinition {
    Name("ClanPush")
    OnCreate { runCatching { ClanWake.channels(ctx()) } }
    OnNewIntent { intent -> take(intent) }
    /** Whether this build carries a Firebase configuration (google-services.json at prebuild). */
    Function("configured") { FirebaseApp.getApps(ctx()).isNotEmpty() }
    AsyncFunction("token") { promise: Promise ->
      if (FirebaseApp.getApps(ctx()).isEmpty()) { promise.resolve(null); return@AsyncFunction }
      FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> promise.resolve(if (t.isSuccessful) t.result else ClanWake.prefs(ctx()).getString("token", null)) }
    }
    /** Per-friend keys (capId, mac, name, convId) that let the native side verify and label wake-ups. */
    Function("setKeys") { json: String -> JSONArray(json); ClanWake.prefs(ctx()).edit().putString("keys", json).apply() }
    Function("setPreviews") { on: Boolean -> ClanWake.prefs(ctx()).edit().putBoolean("previews", on).apply() }
    /** Shared dedupe with local-network alerts: true the first time (kind, id) is seen. */
    Function("firstTime") { key: String -> ClanWake.firstTime(ctx(), key) }
    Function("takeEvents") {
      take(appContext.currentActivity?.intent)
      val p = ClanWake.prefs(ctx()); val s = p.getString("events", "[]") ?: "[]"; p.edit().putString("events", "[]").apply(); s
    }
    Function("cancelCall") { id: String -> androidx.core.app.NotificationManagerCompat.from(ctx()).cancel(ClanWake.callNotificationId(id)) }
    /** Test hook: run a received payload through exactly the production path. */
    Function("handle") { raw: String -> ClanWake.handle(ctx(), raw) }
  }
}
