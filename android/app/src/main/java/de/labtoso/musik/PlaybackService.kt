package de.labtoso.musik

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.media.AudioManager
import android.media.audiofx.Equalizer
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import kotlin.math.ln

/** Plays music in the background and shows the media notification / lock screen controls. */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private var eq: Equalizer? = null
    private val prefs by lazy { getSharedPreferences("musik", Context.MODE_PRIVATE) }
    private val eqListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "eq") applyEq()
        if (key == "play_pauseOnDisconnect") (session?.player as? ExoPlayer)?.setHandleAudioBecomingNoisy(prefs.getBoolean(key, true))
    }
    /** When headphones or a Bluetooth device went away while music was playing (0 = not the case). */
    private var lostAt = 0L
    private val deviceCallback = object : android.media.AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out android.media.AudioDeviceInfo>) {
            val p = session?.player ?: return
            val mine = added.any { it.isSink && it.type != android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER && it.type != android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE && it.type != android.media.AudioDeviceInfo.TYPE_TELEPHONY }
            // the device is back within ten minutes: carry on where the music stopped
            if (mine && lostAt > 0 && System.currentTimeMillis() - lostAt < 600_000 && prefs.getBoolean("play_resumeOnConnect", false) && !p.isPlaying && p.mediaItemCount > 0) {
                lostAt = 0
                p.play()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true
            )
            .setHandleAudioBecomingNoisy(prefs.getBoolean("play_pauseOnDisconnect", true))
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        PlaybackService.player = player
        // the output picked in the app (Bluetooth, headphones or the phone itself) survives a restart
        val pick = prefs.getInt("outputId", 0)
        if (pick != 0) (getSystemService(Context.AUDIO_SERVICE) as AudioManager).getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.id == pick }?.let { player.setPreferredAudioDevice(it) }
        // own audio session so the system equalizer can be attached to it
        val audioSession = (getSystemService(Context.AUDIO_SERVICE) as AudioManager).generateAudioSessionId()
        if (audioSession > 0) {
            player.setAudioSessionId(audioSession)
            PlaybackService.audioSession = audioSession
            eq = runCatching { Equalizer(1000, audioSession) }.getOrNull()
        }
        // some devices only allow the equalizer once sound is playing: try again then
        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                lostAt = if (!playWhenReady && reason == androidx.media3.common.Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY) System.currentTimeMillis() else 0
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isPlaying) return
                if (eq == null && audioSession > 0) eq = runCatching { Equalizer(1000, audioSession) }.getOrNull()
                applyEq()
            }
        })
        prefs.registerOnSharedPreferenceChangeListener(eqListener)
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).registerAudioDeviceCallback(deviceCallback, android.os.Handler(android.os.Looper.getMainLooper()))
        applyEq()
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        session = MediaSession.Builder(this, player)
            .setSessionActivity(open)
            .setCallback(object : MediaSession.Callback {
                // Items from the controller arrive without their URI; restore it from the request metadata.
                override fun onAddMediaItems(
                    mediaSession: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    mediaItems: MutableList<MediaItem>
                ): ListenableFuture<MutableList<MediaItem>> {
                    val resolved = mediaItems.map { item ->
                        val uri = item.requestMetadata.mediaUri ?: item.localConfiguration?.uri
                        if (uri == null) item else item.buildUpon().setUri(uri).build()
                    }.toMutableList()
                    return Futures.immediateFuture(resolved)
                }
            })
            .build()
    }

    /** Maps the app's 10 bands (31 Hz to 16 kHz) plus preamp onto the bands this device offers. */
    private fun applyEq() {
        val e = eq ?: return
        runCatching {
            val raw = prefs.getString("eq", null)
            val cfg = if (raw.isNullOrEmpty()) null else JSONObject(raw)
            val on = cfg?.optBoolean("on", false) ?: false
            if (!on) {
                e.setEnabled(false)
                return
            }
            val gains = cfg!!.optJSONArray("gains")
            val g = DoubleArray(FREQS.size) { gains?.optDouble(it, 0.0) ?: 0.0 }
            val pre = cfg.optDouble("pre", 0.0)
            val range = e.bandLevelRange // millibel
            for (b in 0 until e.numberOfBands) {
                val hz = e.getCenterFreq(b.toShort()) / 1000.0
                val db = interpolate(hz, g) + pre
                val mb = (db * 100).toInt().coerceIn(range[0].toInt(), range[1].toInt())
                e.setBandLevel(b.toShort(), mb.toShort())
            }
            e.setEnabled(true)
        }
    }

    private fun interpolate(hz: Double, g: DoubleArray): Double {
        if (hz <= FREQS.first()) return g.first()
        if (hz >= FREQS.last()) return g.last()
        for (i in 0 until FREQS.size - 1) {
            if (hz <= FREQS[i + 1]) {
                val t = (ln(hz) - ln(FREQS[i])) / (ln(FREQS[i + 1]) - ln(FREQS[i]))
                return g[i] + (g[i + 1] - g[i]) * t
            }
        }
        return 0.0
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    companion object {
        /** Audio session of the player, for the visualizer in the activity (same process). */
        @Volatile var audioSession = 0
        /** The player, so the activity can send the sound to the device picked in the app. */
        @Volatile var player: ExoPlayer? = null
    }

    override fun onDestroy() {
        audioSession = 0
        player = null
        prefs.unregisterOnSharedPreferenceChangeListener(eqListener)
        runCatching { (getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioDeviceCallback(deviceCallback) }
        eq?.release()
        eq = null
        session?.run {
            player.release()
            release()
        }
        session = null
        super.onDestroy()
    }
}

private val FREQS = doubleArrayOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)
