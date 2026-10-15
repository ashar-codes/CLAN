// Native viewer choice and streaming export. Sources must be regular files inside CLAN's private sandbox.
package expo.modules.fileactions

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

class FileActionsModule : Module() {
  private fun source(uri: String): File {
    val ctx = appContext.reactContext ?: error("No context")
    val u = Uri.parse(uri); require(u.scheme == "file") { "Only private downloaded files are allowed." }
    val f = File(u.path ?: error("No path")).canonicalFile
    require(f.isFile && listOf(ctx.filesDir, ctx.cacheDir).any { f.path.startsWith(it.canonicalPath + File.separator) }) { "File is outside private storage." }
    return f
  }
  private fun hash(f: File): String {
    val h = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { input -> val b = ByteArray(64 * 1024); while (true) { val n = input.read(b); if (n < 0) break; h.update(b, 0, n) } }
    return h.digest().joinToString("") { "%02x".format(it) }
  }
  override fun definition() = ModuleDefinition {
    Name("ClanFileActions")
    AsyncFunction("copyText") { text: String ->
      val ctx = appContext.reactContext ?: error("No context")
      (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("CLAN message", text.take(8000)))
    }
    // A verified copy into the shared Gallery (Pictures/CLAN or Movies/CLAN) through MediaStore; never overwrites.
    AsyncFunction("saveToGallery") { uri: String, expected: String, mime: String, name: String ->
      val ctx = appContext.reactContext ?: error("No context")
      require(Build.VERSION.SDK_INT >= 29) { "On Android 9 and older use Save to Files." }
      val video = mime.startsWith("video/"); require(video || mime.startsWith("image/")) { "Only photos and videos go to the Gallery." }
      val f = source(uri)
      require(expected.matches(Regex("[a-f0-9]{64}")) && hash(f) == expected) { "File changed after download." }
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name.replace(Regex("[\\\\/:*?\"<>|\u0000]"), "_").take(120))
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/CLAN")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val collection = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val target = ctx.contentResolver.insert(collection, values) ?: error("The Gallery refused the file (storage full?).")
      try {
        val digest = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input -> (ctx.contentResolver.openOutputStream(target) ?: error("Cannot write to the Gallery")).use { out ->
          val b = ByteArray(64 * 1024); while (true) { val n = input.read(b); if (n < 0) break; digest.update(b, 0, n); out.write(b, 0, n) } } }
        require(digest.digest().joinToString("") { "%02x".format(it) } == expected) { "Copy failed verification." }
        ctx.contentResolver.update(target, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      } catch (e: Exception) { runCatching { ctx.contentResolver.delete(target, null, null) }; throw e }
      target.toString()
    }
    AsyncFunction("openWith") { uri: String, expected: String ->
      val ctx = appContext.reactContext ?: error("No context")
      val f = source(uri)
      val ext = f.extension.lowercase()
      require(ext in setOf("pdf","txt","md","csv","png","jpg","jpeg","gif","webp","mp4","mov","webm","mp3","wav","m4a","docx","pptx","xlsx","odt","odp","ods")) { "This file type may contain code. Save a copy instead." }
      require(expected.matches(Regex("[a-f0-9]{64}")) && hash(f) == expected) { "File changed after download." }
      val content = FileProvider.getUriForFile(ctx, "${ctx.packageName}.FileSystemFileProvider", f)
      val view = Intent(Intent.ACTION_VIEW).setDataAndType(content, MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      ctx.startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }
    AsyncFunction("saveCopy") { uri: String, destination: String, expected: String, expectedSize: Double ->
      val ctx = appContext.reactContext ?: error("No context")
      val f = source(uri)
      val target = Uri.parse(destination)
      require(target.scheme == "content" && DocumentsContract.isDocumentUri(ctx, target)) { "Choose a document destination." }
      require(expected.matches(Regex("[a-f0-9]{64}")) && expectedSize.isFinite() && expectedSize >= 0 && expectedSize == expectedSize.toLong().toDouble() && f.length() == expectedSize.toLong()) { "File size changed." }
      var empty = false
      ctx.contentResolver.query(target, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor -> empty = cursor.moveToFirst() && !cursor.isNull(0) && cursor.getLong(0) == 0L }
      require(empty) { "Choose a new empty document; existing files are never overwritten." }
      var total = 0L; val digest = MessageDigest.getInstance("SHA-256")
      try {
        f.inputStream().use { input ->
          (ctx.contentResolver.openOutputStream(target, "w") ?: error("Cannot write destination")).use { output ->
            val b = ByteArray(64 * 1024)
            while (true) { val n = input.read(b); if (n < 0) break; total += n; require(total <= expectedSize.toLong()) { "File grew while saving." }; digest.update(b, 0, n); output.write(b, 0, n) }
          }
        }
        require(total == expectedSize.toLong() && digest.digest().joinToString("") { "%02x".format(it) } == expected) { "Copy failed verification." }
        val savedHash = MessageDigest.getInstance("SHA-256"); var savedSize = 0L
        (ctx.contentResolver.openInputStream(target) ?: error("Cannot verify destination")).use { input ->
          val b = ByteArray(64 * 1024)
          while (true) { val n = input.read(b); if (n < 0) break; savedSize += n; require(savedSize <= expectedSize.toLong()) { "Saved size changed." }; savedHash.update(b, 0, n) }
        }
        require(savedSize == expectedSize.toLong() && savedHash.digest().joinToString("") { "%02x".format(it) } == expected) { "Saved copy failed verification." }
      } catch (e: Exception) { runCatching { DocumentsContract.deleteDocument(ctx.contentResolver, target) }; throw e }
    }
  }
}
