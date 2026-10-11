// Compile-only stand-ins for expo-modules-core (see check.sh). Never shipped.
package expo.modules.kotlin

import android.app.Activity
import android.content.Context

interface Promise {
  fun resolve(value: Any?)
  fun resolve() {}
  fun reject(code: String, message: String?, cause: Throwable?)
  fun reject(exception: expo.modules.kotlin.exception.CodedException) {}
}
class AppContext { val reactContext: Context? = null; val currentActivity: Activity? = null }
