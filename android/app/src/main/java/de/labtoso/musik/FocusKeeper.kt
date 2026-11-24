package de.labtoso.musik

import android.content.Context
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.os.Handler
import android.os.Looper
import androidx.media3.common.Player

/**
 * Audio focus like a music app should handle it, but without stopping for every game or app:
 *  - calls and recordings pause the music and it carries on afterwards
 *  - another music, video or podcast app that starts playing pauses it (as in Spotify)
 *  - games, short app sounds and apps that only grab focus keep the music running
 *    (lowered while a short sound plays, at full volume otherwise)
 * With the setting "keep playing over other apps" off, it behaves like the standard player.
 */
class FocusKeeper(
    context: Context,
    private val player: Player,
    private val prefs: SharedPreferences,
    /** Volume factor for ducking (1 = normal). The service multiplies it into the player volume. */
    private val duck: (Float) -> Unit,
) {
    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val main = Handler(Looper.getMainLooper())
    private val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()
    private val listener = AudioManager.OnAudioFocusChangeListener { onFocus(it) }
    private val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attrs)
        .setWillPauseWhenDucked(false)
        .setOnAudioFocusChangeListener(listener, main)
        .build()

    private var held = false
    /** Paused because of a call or a short sound from another app: play again once focus comes back. */
    private var resumeOnGain = false
    /** Lost focus but kept playing: watch for a media app starting late. */
    private var watching = false
    private var watchTransient = false
    private var base = Counts(0, 0, 0)
    private val retakes = ArrayDeque<Long>()
    private var decide: Runnable? = null
    private var stopped = false
    /** Audio outputs our own player has open right now; they are taken out of every count. */
    private var ownTracks = 0
    /** Our player just opened or closed an output: the system's list may lag behind until then. */
    private var graceUntil = 0L
    /** Grace over: judge what changed meanwhile with the same rule. The base keeps foreign streams out. */
    private val recheck = Runnable {
        if (stopped || decide != null) return@Runnable
        val now = count(am.activePlaybackConfigurations)
        if (!watching) base = now
        else if (player.playWhenReady && foreign(now)) pauseFor(watchTransient)
    }

    private val keepOn get() = prefs.getBoolean("play_keepWithApps", true)

    private val playbackCallback = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
            if (!watching || !player.playWhenReady || System.currentTimeMillis() < graceUntil) return
            // a music, video or podcast app started after all: give way to it
            if (foreign(count(configs))) pauseFor(watchTransient)
        }
    }

    /** A recording that starts later (voice message, video) without asking for focus also pauses the music. */
    private val recordingCallback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<android.media.AudioRecordingConfiguration>) {
            if (stopped) return
            // the recording ended after focus had already come back: carry on now
            if (held && resumeOnGain && !inCall()) {
                resumeOnGain = false
                player.play()
                return
            }
            if (!player.playWhenReady || !keepOn || configs.none(::realRecording)) return
            // focus already lost to the recording app: carry on once it gives focus back
            pauseFor(transient = !held)
        }
    }

    init {
        am.registerAudioPlaybackCallback(playbackCallback, main)
        am.registerAudioRecordingCallback(recordingCallback, main)
    }

    /** Same rule as the decision after a focus loss, so a late start is judged the same way. */
    private fun foreign(now: Counts): Boolean {
        if (now.media > base.media) return true
        return !watchTransient && now.unknown > base.unknown && now.game <= base.game
    }

    /** Called when the player starts or stops wanting to play. */
    fun onPlayWhenReady(play: Boolean) {
        if (stopped) return
        if (play) {
            resumeOnGain = false
            if (!held) obtain()
        } else if (!resumeOnGain) {
            release()
        }
    }

    /**
     * The player opened (+1) or closed (-1) an audio output, for example for a song with another sample rate.
     * It belongs to us, so it must not look like another app starting to play.
     */
    fun ownTrackChanged(delta: Int) {
        ownTracks = (ownTracks + delta).coerceAtLeast(0)
        graceUntil = System.currentTimeMillis() + GRACE
        main.removeCallbacks(recheck)
        main.postDelayed(recheck, GRACE)
    }

    private fun obtain() {
        base = count(am.activePlaybackConfigurations)
        val r = am.requestAudioFocus(request)
        held = r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        // refused (a call is running): stay paused, as any player would
        if (!held && r == AudioManager.AUDIOFOCUS_REQUEST_FAILED) {
            resumeOnGain = false
            player.pause()
        }
    }

    private fun release() {
        cancelDecide()
        watching = false
        duck(1f)
        // also after a short loss: the request must leave the system's focus stack
        am.abandonAudioFocusRequest(request)
        held = false
    }

    private fun onFocus(change: Int) {
        if (stopped) return
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> {
                held = true
                cancelDecide()
                watching = false
                // what plays now next to us is the new starting point for the next loss
                base = count(am.activePlaybackConfigurations)
                duck(1f)
                if (resumeOnGain && !inCall()) {
                    resumeOnGain = false
                    player.play()
                }
            }
            // the system lowers the music by itself (navigation, notifications)
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> Unit
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                held = false
                lost(transient = true)
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                held = false
                lost(transient = false)
            }
        }
    }

    private fun lost(transient: Boolean) {
        cancelDecide()
        if (!player.playWhenReady) return
        if (!keepOn) return pauseFor(transient)
        if (inCall()) return pauseFor(true)
        // lower the music right away for a short sound, then look at what the other app plays
        if (transient) duck(DUCK)
        lateinit var r: Runnable
        r = Runnable {
            // our own output changed meanwhile: wait until the system's list has caught up
            val left = graceUntil - System.currentTimeMillis()
            if (left > 0) return@Runnable run { main.postDelayed(r, left) }
            decide = null
            judge(transient)
        }
        decide = r
        // the other app usually opens its audio a moment after it asked for focus;
        // and if our own output just changed, wait until the system's list has caught up
        val wait = maxOf(if (transient) 350L else 900L, graceUntil - System.currentTimeMillis())
        main.postDelayed(r, wait)
    }

    private fun judge(transient: Boolean) {
        if (!player.playWhenReady) return
        if (inCall()) return pauseFor(true)
        val now = count(am.activePlaybackConfigurations)
        val media = now.media > base.media
        // video players without a content type look like this too; a new game sound next to it means a game
        val unknown = now.unknown > base.unknown && now.game <= base.game
        if (media || (!transient && unknown)) return pauseFor(transient)
        // a game or an app sound: keep playing
        watching = true
        watchTransient = transient
        if (transient) return
        // Since Android 12 the system mutes a player that lost focus to another app until it asks again.
        // Ask once more so the music stays audible next to the game. If the other app keeps taking it back,
        // stop fighting and pause like any player.
        val t = System.currentTimeMillis()
        while (retakes.isNotEmpty() && t - retakes.first() > 60_000) retakes.removeFirst()
        if (retakes.size >= 2) return pauseFor(false)
        retakes.addLast(t)
        held = am.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun pauseFor(transient: Boolean) {
        cancelDecide()
        watching = false
        duck(1f)
        resumeOnGain = transient
        player.pause()
        if (!transient) release()
    }

    private fun inCall(): Boolean {
        val m = am.mode
        if (m == AudioManager.MODE_IN_CALL || m == AudioManager.MODE_IN_COMMUNICATION || m == AudioManager.MODE_RINGTONE) return true
        if (android.os.Build.VERSION.SDK_INT >= 30 && m == AudioManager.MODE_CALL_SCREENING) return true
        // someone records a voice message or a video: the music must not end up in it
        return am.activeRecordingConfigurations.any(::realRecording)
    }

    /** Hotword listening ("Hey Google") and silenced recordings are not someone recording. */
    private fun realRecording(c: android.media.AudioRecordingConfiguration): Boolean {
        if (c.clientAudioSource == HOTWORD_SOURCE) return false
        return !(android.os.Build.VERSION.SDK_INT >= 29 && c.isClientSilenced)
    }

    private fun cancelDecide() {
        decide?.let { main.removeCallbacks(it) }
        decide = null
    }

    fun stop() {
        stopped = true
        resumeOnGain = false
        main.removeCallbacks(recheck)
        release()
        runCatching { am.unregisterAudioPlaybackCallback(playbackCallback) }
        runCatching { am.unregisterAudioRecordingCallback(recordingCallback) }
    }

    private data class Counts(val media: Int, val unknown: Int, val game: Int)

    private fun count(list: List<AudioPlaybackConfiguration>): Counts {
        var media = 0
        var unknown = 0
        var game = 0
        for (c in list) {
            val a = c.audioAttributes
            when (a.usage) {
                AudioAttributes.USAGE_MEDIA -> when (a.contentType) {
                    AudioAttributes.CONTENT_TYPE_MUSIC, AudioAttributes.CONTENT_TYPE_MOVIE, AudioAttributes.CONTENT_TYPE_SPEECH -> media++
                    AudioAttributes.CONTENT_TYPE_UNKNOWN -> unknown++
                }
                AudioAttributes.USAGE_GAME -> game++
            }
        }
        // our own player plays music: take its outputs out
        return Counts((media - ownTracks).coerceAtLeast(0), unknown, game)
    }

    companion object {
        private const val DUCK = 0.25f
        private const val GRACE = 1500L
        /** MediaRecorder.AudioSource.HOTWORD (hidden in the SDK). */
        private const val HOTWORD_SOURCE = 1999
    }
}
