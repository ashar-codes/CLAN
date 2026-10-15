package expo.modules.clanpush

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ClanMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) { ClanWake.handle(applicationContext, message.data["clan"]) }
  override fun onNewToken(token: String) { ClanWake.prefs(applicationContext).edit().putString("token", token).apply() }
}
