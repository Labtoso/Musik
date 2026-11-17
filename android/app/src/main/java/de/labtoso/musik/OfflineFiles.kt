package de.labtoso.musik

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

/**
 * The songs kept on the phone for offline mode, shown in the system's Files app under "Streyn".
 * They lie in the app's own storage, which no file manager can open by itself.
 */
class OfflineFiles : DocumentsProvider() {
    companion object {
        const val ROOT = "streyn"
        fun authority(pkg: String) = "$pkg.offline"
        fun dir(base: File): File = File(base, "offline/music/songs")
    }

    private val rootCols = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_FLAGS, Root.COLUMN_TITLE, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_ICON, Root.COLUMN_AVAILABLE_BYTES)
    private val docCols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)

    private fun base(): File = dir(context!!.filesDir).apply { mkdirs() }

    private fun fileOf(id: String): File {
        val b = base()
        val f = if (id == ROOT) b else File(b, id.removePrefix("$ROOT/"))
        // never outside the songs folder
        if (!f.canonicalPath.startsWith(b.canonicalPath)) throw FileNotFoundException(id)
        if (!f.exists()) throw FileNotFoundException(id)
        return f
    }

    private fun idOf(f: File): String {
        val b = base().canonicalPath
        val p = f.canonicalPath
        return if (p == b) ROOT else "$ROOT/" + p.removePrefix("$b/")
    }

    private fun mime(f: File): String =
        if (f.isDirectory) Document.MIME_TYPE_DIR
        else MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"

    private fun row(c: MatrixCursor, f: File) {
        val flags = if (f.isDirectory) 0 else Document.FLAG_SUPPORTS_DELETE
        c.newRow()
            .add(Document.COLUMN_DOCUMENT_ID, idOf(f))
            .add(Document.COLUMN_DISPLAY_NAME, if (idOf(f) == ROOT) "Streyn" else f.name)
            .add(Document.COLUMN_MIME_TYPE, mime(f))
            .add(Document.COLUMN_FLAGS, flags)
            .add(Document.COLUMN_SIZE, if (f.isDirectory) null else f.length())
            .add(Document.COLUMN_LAST_MODIFIED, f.lastModified())
    }

    override fun onCreate(): Boolean = true

    override fun queryRoots(projection: Array<out String>?): Cursor = MatrixCursor(projection ?: rootCols).apply {
        newRow()
            .add(Root.COLUMN_ROOT_ID, ROOT)
            .add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_IS_CHILD)
            .add(Root.COLUMN_TITLE, "Streyn")
            .add(Root.COLUMN_DOCUMENT_ID, ROOT)
            .add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            .add(Root.COLUMN_AVAILABLE_BYTES, base().usableSpace)
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
        MatrixCursor(projection ?: docCols).apply { row(this, fileOf(documentId)) }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor =
        MatrixCursor(projection ?: docCols).apply {
            fileOf(parentDocumentId).listFiles()?.filter { !it.name.endsWith(".part") }?.sortedBy { it.name.lowercase() }?.forEach { row(this, it) }
        }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileOf(documentId), ParcelFileDescriptor.MODE_READ_ONLY)

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean =
        documentId != parentDocumentId && (parentDocumentId == ROOT || documentId.startsWith("$parentDocumentId/"))

    override fun deleteDocument(documentId: String) {
        val f = fileOf(documentId)
        if (f.isFile) f.delete()
    }
}
