// CLAN Share-to-CLAN (Android): what another app shared (SEND / SEND_MULTIPLE) is copied into this app's private cache
// with strict limits, then handed to JS once. Untrusted input: only content:// streams granted with this intent are
// read (file:// and other schemes are refused), at most 10 items, each at most 200 MB (copying stops past the limit),
// names are reduced to a safe file name, text is capped. Nothing is published anywhere from here.
package expo.modules.shareintake

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

private const val MAX_ITEMS = 10
private const val MAX_BYTES = 200L * 1024 * 1024
private const val MAX_TEXT = 20_000

class ShareIntakeModule : Module() {
  private var pending: Intent? = null

  private fun isShare(i: Intent?) = i != null && (i.action == Intent.ACTION_SEND || i.action == Intent.ACTION_SEND_MULTIPLE)

  @Suppress("DEPRECATION")
  private fun streams(i: Intent): List<Uri> = when (i.action) {
    Intent.ACTION_SEND -> listOfNotNull(if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableExtra(Intent.EXTRA_STREAM))
    else -> (if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
  }

  private fun safeName(n: String?) = (n ?: "shared").replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").take(120).ifBlank { "shared" }

  private fun take(i: Intent): Map<String, Any?> {
    val ctx = appContext.reactContext ?: throw IllegalStateException("no context")
    val cr = ctx.contentResolver
    val out = mutableListOf<Map<String, Any?>>(); val errors = mutableListOf<String>()
    val dir = File(ctx.cacheDir, "share-in").apply { mkdirs() }
    for (u in streams(i).take(MAX_ITEMS)) {
      if (u.scheme != "content") { errors += "Skipped an item that wasn't shared as content."; continue }
      var name: String? = null; var size: Long? = null
      try { cr.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c -> if (c.moveToFirst()) { name = c.getString(0); if (!c.isNull(1)) size = c.getLong(1) } } } catch (_: Exception) {}
      if ((size ?: 0) > MAX_BYTES) { errors += "${safeName(name)} is over 200 MB."; continue }
      val dest = File(dir, "${UUID.randomUUID()}-${safeName(name)}")
      try {
        var total = 0L
        cr.openInputStream(u)?.use { input -> dest.outputStream().use { o ->
          val buf = ByteArray(64 * 1024)
          while (true) { val n = input.read(buf); if (n < 0) break; total += n; if (total > MAX_BYTES) throw IllegalStateException("too large"); o.write(buf, 0, n) }
        } } ?: throw IllegalStateException("unreadable")
        out += mapOf("uri" to Uri.fromFile(dest).toString(), "name" to safeName(name), "mime" to (cr.getType(u) ?: "application/octet-stream"), "size" to total.toDouble())
      } catch (e: Exception) { dest.delete(); errors += if (e.message == "too large") "${safeName(name)} is over 200 MB." else "Couldn't read ${safeName(name)}." }
    }
    if (streams(i).size > MAX_ITEMS) errors += "Only the first $MAX_ITEMS items were taken."
    return mapOf("text" to i.getStringExtra(Intent.EXTRA_TEXT)?.take(MAX_TEXT), "subject" to i.getStringExtra(Intent.EXTRA_SUBJECT)?.take(300), "files" to out, "errors" to errors)
  }

  override fun definition() = ModuleDefinition {
    Name("ShareIntake")
    Events("share")
    OnCreate { appContext.currentActivity?.intent?.let { if (isShare(it)) pending = it } }
    OnNewIntent { i -> if (isShare(i)) { pending = i; sendEvent("share", mapOf("waiting" to true)) } }
    /** The share waiting to be handled (copied into the app), or null. Each share is handed out once. */
    AsyncFunction("take") { _id: String? -> // the id is the iOS hand-off; Android takes the pending intent
      val i = pending ?: appContext.currentActivity?.intent?.takeIf { isShare(it) }
      val result: Map<String, Any?>? = if (i == null) null else { pending = null; appContext.currentActivity?.intent = Intent(); take(i) } // never re-process a share
      result
    }
    /** Clears copies the student didn't keep (they are in the private cache only). */
    Function("discard") { uris: List<String> -> uris.forEach { runCatching { val f = File(Uri.parse(it).path!!); if (f.parentFile?.name == "share-in") f.delete() } }; Unit }
  }
}
