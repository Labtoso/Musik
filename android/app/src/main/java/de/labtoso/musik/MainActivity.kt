package de.labtoso.musik

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.media.audiofx.Visualizer
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var controllerFuture: ListenableFuture<MediaController>
    private var controller: MediaController? = null
    private val pending = ArrayList<(MediaController) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val prefs by lazy { getSharedPreferences("musik", MODE_PRIVATE) }

    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }

    private val ticker = object : Runnable {
        override fun run() {
            controller?.let { if (it.isPlaying) emitTime(it) }
            main.postDelayed(this, 500)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#111214")
        window.navigationBarColor = Color.parseColor("#111214")

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#111214"))
        // a WebView ignores its own padding, so the frame around it keeps the page clear of the
        // status bar, the navigation bar and the keyboard
        val frame = android.widget.FrameLayout(this)
        frame.setBackgroundColor(Color.parseColor("#111214"))
        frame.addView(web, android.widget.FrameLayout.LayoutParams(-1, -1))
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = true
        }
        web.addJavascriptInterface(Bridge(), "MusikAndroid")
        audio.registerAudioDeviceCallback(deviceCallback, main)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                val server = prefs.getString("server", null)
                val remote = prefs.getString("remote", null)
                if (url.startsWith("file:///android_asset/") || (server != null && url.startsWith(server)) || (remote != null && url.startsWith(remote))) return false
                // Spotify sign-in runs inside the app and comes back to the server address
                val host = request.url.host ?: ""
                if (host == "spotify.com" || host.endsWith(".spotify.com")) return false
                if (!request.isForMainFrame) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && !request.url.toString().startsWith("file:")) openBest()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // Spotify's player needs protected media (Widevine); nothing else is granted
            override fun onPermissionRequest(request: PermissionRequest) {
                val want = request.resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
                if (want.isNotEmpty()) request.grant(want.toTypedArray()) else request.deny()
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(arrayOf())
                fileCallback = callback
                pickFiles.launch("audio/*")
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.musikBack ? window.musikBack() : false)") { r ->
                    if (r != "true") {
                        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
                    }
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        val server = prefs.getString("server", null)
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else if (server == null) showConnect("") else openBest()

        connectController()
        main.post(ticker)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    /** Home address first, then the address for on the go (Tailscale) that the server told us about. */
    private var lastOpen = 0L
    private fun openBest() {
        val now = System.currentTimeMillis()
        if (now - lastOpen < 8000) return showConnect("offline")
        lastOpen = now
        val server = prefs.getString("server", null) ?: return showConnect("")
        val remote = prefs.getString("remote", null)
        thread {
            val target = when {
                check(server, 3000) == "ok" -> server
                remote != null && check(remote) == "ok" -> remote
                else -> null
            }
            main.post { if (target != null) web.loadUrl("$target/") else showConnect("offline") }
        }
    }

    private fun showConnect(error: String) {
        val server = Uri.encode(prefs.getString("server", "") ?: "")
        web.loadUrl("file:///android_asset/connect.html?server=$server&error=$error")
    }

    private fun connectController() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        controllerFuture = MediaController.Builder(this, token).buildAsync()
        controllerFuture.addListener({
            val c = runCatching { controllerFuture.get() }.getOrNull() ?: return@addListener
            controller = c
            c.addListener(playerListener)
            pending.forEach { it(c) }
            pending.clear()
            // Tell the page about a session that was already playing (e.g. app reopened).
            if (c.mediaItemCount > 0) {
                emit(JSONObject().put("type", "index").put("index", c.currentMediaItemIndex).put("reason", "restore"))
                emit(JSONObject().put("type", "playing").put("playing", c.isPlaying))
            }
        }, MoreExecutors.directExecutor())
    }

    private fun withController(action: (MediaController) -> Unit) {
        main.post {
            val c = controller
            if (c != null) action(c) else pending.add(action)
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val c = controller ?: return
            val r = when (reason) {
                Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "ended"
                Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT -> "repeat"
                else -> "user"
            }
            emit(JSONObject().put("type", "index").put("index", c.currentMediaItemIndex).put("reason", r))
            emitTime(c)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            emit(JSONObject().put("type", "playing").put("playing", isPlaying))
        }

        override fun onPlaybackStateChanged(state: Int) {
            val c = controller ?: return
            emit(JSONObject().put("type", "buffering").put("buffering", state == Player.STATE_BUFFERING))
            if (state == Player.STATE_ENDED) {
                emit(JSONObject().put("type", "index").put("index", c.currentMediaItemIndex).put("reason", "end"))
                emit(JSONObject().put("type", "playing").put("playing", false))
            }
            if (state == Player.STATE_READY) emitTime(c)
        }

        override fun onPlayerError(error: PlaybackException) {
            emit(JSONObject().put("type", "error").put("message", error.errorCodeName))
            val c = controller ?: return
            if (c.hasNextMediaItem()) {
                c.seekToNextMediaItem()
                c.prepare()
                c.play()
            }
        }
    }

    private fun emitTime(c: MediaController) {
        val dur = if (c.duration > 0) c.duration / 1000.0 else 0.0
        emit(JSONObject().put("type", "time").put("position", c.currentPosition / 1000.0).put("duration", dur))
    }

    // ---- app update: download the latest APK from the release page and hand it to the installer
    private fun updState(s: String, pct: Int = 0) {
        main.post { web.evaluateJavascript("window.musikAppUpdate && window.musikAppUpdate(${JSONObject.quote(s)}, $pct)", null) }
    }

    private fun downloadAndInstall() {
        if (!packageManager.canRequestPackageInstalls()) {
            updState("permission")
            main.post { runCatching { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) } }
            return
        }
        try {
            val dir = File(cacheDir, "updates").apply { mkdirs() }
            val out = File(dir, "Musik.apk")
            var url = URL("https://github.com/Labtoso/Musik/releases/latest/download/Musik.apk")
            lateinit var conn: HttpURLConnection
            var hops = 0
            while (true) {
                conn = url.openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 15000
                conn.readTimeout = 30000
                conn.setRequestProperty("User-Agent", "Musik-Android")
                val code = conn.responseCode
                if (code in 300..399 && hops < 8) {
                    url = URL(url, conn.getHeaderField("Location"))
                    conn.disconnect()
                    hops++
                    continue
                }
                if (code != 200) throw IllegalStateException("http $code")
                break
            }
            val total = conn.contentLengthLong
            updState("download", 0)
            conn.inputStream.use { inp ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = -1
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val p = (done * 100 / total).toInt()
                            if (p != last) { last = p; updState("download", p) }
                        }
                    }
                }
            }
            conn.disconnect()
            if (out.length() < 1_000_000) throw IllegalStateException("short download")
            // an app signed with another key can't be installed over this one: say so instead of a silent failure
            if (!sameSigner(out)) { updState("signature"); return }
            updState("install")
            val uri = FileProvider.getUriForFile(this, "$packageName.files", out)
            val i = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            main.post { runCatching { startActivity(i) }.onFailure { updState("error") } }
        } catch (e: Exception) {
            updState("error")
        }
    }

    private fun signers(info: android.content.pm.PackageInfo?): Set<String> {
        val si = info?.signingInfo ?: return emptySet()
        val list = if (si.hasMultipleSigners()) si.apkContentsSigners else si.signingCertificateHistory
        return list?.map { java.util.Arrays.hashCode(it.toByteArray()).toString() }?.toSet() ?: emptySet()
    }

    @Suppress("DEPRECATION")
    private fun sameSigner(apk: File): Boolean = runCatching {
        if (Build.VERSION.SDK_INT < 28) return@runCatching true
        val flag = PackageManager.GET_SIGNING_CERTIFICATES
        val mine = signers(packageManager.getPackageInfo(packageName, flag))
        val theirs = signers(packageManager.getPackageArchiveInfo(apk.absolutePath, flag))
        mine.isEmpty() || theirs.isEmpty() || mine.intersect(theirs).isNotEmpty()
    }.getOrDefault(true)

    private fun emit(o: JSONObject) {
        val js = "window.__musikNative && window.__musikNative(${JSONObject.quote(o.toString())})"
        main.post { web.evaluateJavascript(js, null) }
    }

    private fun toItems(json: String): List<MediaItem> {
        val arr = JSONArray(json)
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            val uri = Uri.parse(o.getString("url"))
            val art = o.optString("artwork")
            val meta = MediaMetadata.Builder()
                .setTitle(o.optString("title"))
                .setArtist(o.optString("artist"))
                .setAlbumTitle(o.optString("album"))
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .apply { if (art.isNotEmpty()) setArtworkUri(Uri.parse(art)) }
                .build()
            MediaItem.Builder()
                .setMediaId(o.optString("id", i.toString()))
                .setUri(uri)
                .setMediaMetadata(meta)
                .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
                .build()
        }
    }

    private fun normalize(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        if (!s.matches(Regex("^https?://.*", RegexOption.IGNORE_CASE))) s = "http://$s"
        return runCatching {
            val u = Uri.parse(s)
            val host = u.host ?: return null
            var port = u.port
            if (port == -1 && u.scheme == "http" && !host.matches(Regex(".*\\.[a-zA-Z]{2,}$"))) port = 8484
            "${u.scheme}://$host" + (if (port != -1) ":$port" else "")
        }.getOrNull()
    }

    private fun check(origin: String, timeout: Int = 6000): String = runCatching {
        val conn = URL("$origin/api/info").openConnection() as HttpURLConnection
        conn.connectTimeout = timeout
        conn.readTimeout = timeout
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        val info = JSONObject(text)
        if (info.optString("app") == "musik") {
            val remote = info.optString("remote", "").trimEnd('/')
            if (remote.startsWith("http")) prefs.edit().putString("remote", remote).apply()
            "ok"
        } else "notmusik"
    }.getOrElse { "offline" }

    inner class Bridge {
        @JavascriptInterface fun setQueue(json: String, index: Int, posMs: Long, autoplay: Boolean) {
            val items = toItems(json)
            withController { c ->
                c.setMediaItems(items, index.coerceIn(0, maxOf(0, items.size - 1)), posMs)
                c.prepare()
                c.playWhenReady = autoplay
            }
        }
        @JavascriptInterface fun insert(at: Int, json: String) {
            val items = toItems(json)
            withController { c -> c.addMediaItems(at.coerceIn(0, c.mediaItemCount), items) }
        }
        @JavascriptInterface fun remove(i: Int) = withController { c -> if (i in 0 until c.mediaItemCount) c.removeMediaItem(i) }
        @JavascriptInterface fun move(from: Int, to: Int) = withController { c -> c.moveMediaItem(from, to) }
        @JavascriptInterface fun jump(i: Int) = withController { c ->
            if (i in 0 until c.mediaItemCount) {
                c.seekToDefaultPosition(i)
                c.prepare()
                c.play()
            }
        }
        @JavascriptInterface fun play() = withController { c ->
            if (c.playbackState == Player.STATE_IDLE || c.playbackState == Player.STATE_ENDED) {
                if (c.playbackState == Player.STATE_ENDED) c.seekToDefaultPosition(0)
                c.prepare()
            }
            c.play()
        }
        @JavascriptInterface fun pause() = withController { c -> c.pause() }
        @JavascriptInterface fun seek(ms: Long) = withController { c -> c.seekTo(ms) }
        @JavascriptInterface fun next() = withController { c -> if (c.hasNextMediaItem()) c.seekToNextMediaItem() }
        @JavascriptInterface fun prev() = withController { c ->
            if (c.currentMediaItemIndex > 0) c.seekToDefaultPosition(c.currentMediaItemIndex - 1) else c.seekTo(0)
        }
        @JavascriptInterface fun setVolume(v: Double) = withController { c -> c.volume = v.toFloat().coerceIn(0f, 1f) }
        @JavascriptInterface fun setRepeat(mode: String) = withController { c ->
            c.repeatMode = when (mode) {
                "one" -> Player.REPEAT_MODE_ONE
                "all" -> Player.REPEAT_MODE_ALL
                else -> Player.REPEAT_MODE_OFF
            }
        }
        // Visualizer: Android only hands out the spectrum with the record-audio permission (nothing is recorded)
        @JavascriptInterface fun vizStart() = main.post {
            if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) attachViz()
            else askAudio.launch(Manifest.permission.RECORD_AUDIO)
        }
        @JavascriptInterface fun vizStop() = main.post { releaseViz() }
        @JavascriptInterface fun vizBands(): String {
            val v = viz ?: return ""
            if (vizSession != PlaybackService.audioSession) return ""
            return runCatching {
                if (v.getFft(fft) != Visualizer.SUCCESS) return ""
                val n = fft.size / 2
                val rate = v.samplingRate / 1000.0 // mHz -> Hz
                val hzPerBin = rate / 2 / n
                val out = IntArray(64)
                val lo = Math.log(40.0)
                val hi = Math.log(16000.0)
                for (i in 0 until 64) {
                    val f0 = Math.exp(lo + (hi - lo) * i / 64)
                    val f1 = Math.exp(lo + (hi - lo) * (i + 1) / 64)
                    val b0 = maxOf(1, (f0 / hzPerBin).toInt())
                    val b1 = minOf(n - 1, maxOf(b0, Math.ceil(f1 / hzPerBin).toInt()))
                    var m = 0.0
                    for (b in b0..b1) {
                        val re = fft[2 * b].toDouble()
                        val im = fft[2 * b + 1].toDouble()
                        val mag = Math.hypot(re, im)
                        if (mag > m) m = mag
                    }
                    // magnitude (0..~181) to a 0..255 level on a dB scale
                    val db = 20 * Math.log10(m + 1) / 45.0
                    out[i] = (db.coerceIn(0.0, 1.0) * 255).toInt()
                }
                out.joinToString(",")
            }.getOrDefault("")
        }
        @JavascriptInterface fun setEq(json: String) {
            // PlaybackService listens for this key and applies it to the system equalizer
            prefs.edit().putString("eq", json).apply()
        }
        @JavascriptInterface fun share(title: String, url: String) = main.post {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, title)
                putExtra(Intent.EXTRA_TEXT, if (title.isBlank()) url else "$title\n$url")
            }
            runCatching { startActivity(Intent.createChooser(send, null)) }
        }
        @JavascriptInterface fun openExternal(url: String) {
            if (!url.startsWith("https://")) return
            main.post { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
        }
        @JavascriptInterface fun copy(text: String) {
            main.post {
                val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Musik", text))
            }
        }
        @JavascriptInterface fun appVersion(): String =
            runCatching { packageManager.getPackageInfo(packageName, 0).versionName ?: "" }.getOrDefault("")
        @JavascriptInterface fun updateApp() { thread { downloadAndInstall() } }
        // only a language the person picked ("lang" of older versions was set without asking)
        @JavascriptInterface fun getLang(): String = prefs.getString("langChosen", "") ?: ""
        @JavascriptInterface fun setLang(lang: String) {
            if (lang == "de" || lang == "en") prefs.edit().putString("langChosen", lang).apply()
        }
        @JavascriptInterface fun setAccent(name: String) {
            prefs.edit().putString("accent", name).apply()
        }
        /** Where the sound goes right now and what else is connected (headphones, Bluetooth, USB). */
        @JavascriptInterface fun audioDevices(): String = runCatching { outputs().toString() }.getOrDefault("[]")
        /** The system's output picker (Android 12 and newer), otherwise the Bluetooth settings. */
        @JavascriptInterface fun openOutput() = main.post {
            val ok = runCatching {
                if (Build.VERSION.SDK_INT >= 34) {
                    android.media.MediaRouter2.getInstance(this@MainActivity).showSystemOutputSwitcher()
                } else if (Build.VERSION.SDK_INT >= 31) {
                    sendBroadcast(
                        Intent("com.android.systemui.action.LAUNCH_MEDIA_OUTPUT_DIALOG")
                            .setPackage("com.android.systemui")
                            .putExtra("package_name", packageName)
                    )
                    true
                } else false
            }.getOrDefault(false)
            if (!ok) runCatching { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }
        }
        @JavascriptInterface fun setOutput(id: Int) = main.post { pickOutput(id) }
        @JavascriptInterface fun openBluetooth() = main.post { runCatching { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) } }
        @JavascriptInterface fun getPlayPref(key: String): Boolean = prefs.getBoolean("play_$key", key == "pauseOnDisconnect")
        @JavascriptInterface fun setPlayPref(key: String, on: Boolean) {
            if (key == "pauseOnDisconnect" || key == "resumeOnConnect") prefs.edit().putBoolean("play_$key", on).apply()
        }
        @JavascriptInterface fun getServer(): String = prefs.getString("server", "") ?: ""
        @JavascriptInterface fun changeServer() = main.post { showConnect("") }
        @JavascriptInterface fun connect(input: String) {
            thread {
                val origin = normalize(input)
                if (origin != null && origin != prefs.getString("server", null)) prefs.edit().remove("remote").apply()
                val state = if (origin == null) "offline" else check(origin)
                main.post {
                    if (state == "ok" && origin != null) {
                        prefs.edit().putString("server", origin).apply()
                        if (prefs.getString("remote", null) == origin) prefs.edit().remove("remote").apply()
                        web.loadUrl("$origin/")
                    } else {
                        web.evaluateJavascript("window.onConnectResult && window.onConnectResult(${JSONObject.quote(state)})", null)
                    }
                }
            }
        }
    }

    private val audio by lazy { getSystemService(AUDIO_SERVICE) as android.media.AudioManager }

    private fun kindOf(type: Int): String? = when (type) {
        android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, 26 /* BLE headset */, 27 /* BLE speaker */, 30 /* BLE broadcast */ -> "bluetooth"
        android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES, android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
        android.media.AudioDeviceInfo.TYPE_USB_DEVICE, android.media.AudioDeviceInfo.TYPE_USB_HEADSET, android.media.AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb"
        android.media.AudioDeviceInfo.TYPE_HDMI, android.media.AudioDeviceInfo.TYPE_HDMI_ARC -> "hdmi"
        android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "phone"
        else -> null
    }

    /** Where music plays right now: what the system routes media to (Android 13+), else the device picked in the app, else the one connected last. */
    private fun activeOutput(list: List<Pair<String, android.media.AudioDeviceInfo>>): Int {
        val picked = prefs.getInt("outputId", 0)
        if (picked != 0 && list.any { it.second.id == picked }) return picked
        if (Build.VERSION.SDK_INT >= 33) {
            val attrs = android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_MEDIA).setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC).build()
            val routed = runCatching { audio.getAudioDevicesForAttributes(attrs) }.getOrNull().orEmpty()
            routed.firstNotNullOfOrNull { r -> list.firstOrNull { it.second.id == r.id || (it.second.type == r.type && it.second.productName == r.productName) } }?.let { return it.second.id }
        }
        return list.firstOrNull()?.second?.id ?: 0
    }

    /** Outputs for music with the one that plays now marked. Android sends music to the device connected last, the phone's own speaker comes last. */
    private fun outputs(): JSONArray {
        val all = audio.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).mapNotNull { d -> kindOf(d.type)?.let { it to d } }
        val seen = HashSet<String>()
        val rank = mapOf("bluetooth" to 0, "usb" to 1, "wired" to 2, "hdmi" to 3, "phone" to 4)
        // one entry per device (Bluetooth devices show up once per profile)
        val list = all.sortedBy { rank[it.first] ?: 9 }.filter { seen.add(it.first + ":" + it.second.productName) }
        val active = activeOutput(list)
        val arr = JSONArray()
        list.forEach { (kind, d) ->
            arr.put(JSONObject().put("id", d.id).put("kind", kind).put("name", if (kind == "phone") "" else d.productName?.toString() ?: "").put("active", d.id == active))
        }
        return arr
    }

    /** Sends the music to this device (0 = let Android decide again). */
    @androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
    private fun pickOutput(id: Int) {
        val dev = if (id == 0) null else audio.getDevices(android.media.AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.id == id }
        if (id != 0 && dev == null) return
        // the phone's own speaker as a choice means "stay here", even when Bluetooth is connected
        prefs.edit().putInt("outputId", id).apply()
        PlaybackService.player?.setPreferredAudioDevice(dev)
        main.postDelayed({ web.evaluateJavascript("window.musikDevices && window.musikDevices()", null) }, 300)
    }

    private val deviceCallback = object : android.media.AudioDeviceCallback() {
        private fun tell() { web.evaluateJavascript("window.musikDevices && window.musikDevices()", null) }
        override fun onAudioDevicesAdded(added: Array<out android.media.AudioDeviceInfo>) = tell()
        override fun onAudioDevicesRemoved(removed: Array<out android.media.AudioDeviceInfo>) {
            val picked = prefs.getInt("outputId", 0)
            if (picked != 0 && removed.any { it.id == picked }) prefs.edit().putInt("outputId", 0).apply()
            tell()
        }
    }

    private var viz: Visualizer? = null
    private var vizSession = 0
    private var fft = ByteArray(1024)

    private fun attachViz() {
        val session = PlaybackService.audioSession
        if (session == 0) return
        if (viz != null && vizSession == session) return
        releaseViz()
        viz = runCatching {
            Visualizer(session).apply {
                setCaptureSize(Visualizer.getCaptureSizeRange()[1].coerceAtMost(1024))
                fft = ByteArray(getCaptureSize())
                setEnabled(true)
            }
        }.getOrNull()
        vizSession = if (viz != null) session else 0
    }

    private fun releaseViz() {
        runCatching { viz?.release() }
        viz = null
        vizSession = 0
    }

    private val askAudio = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> if (ok) attachViz() }

    override fun onDestroy() {
        runCatching { audio.unregisterAudioDeviceCallback(deviceCallback) }
        releaseViz()
        main.removeCallbacks(ticker)
        controller?.removeListener(playerListener)
        MediaController.releaseFuture(controllerFuture)
        super.onDestroy()
    }
}
