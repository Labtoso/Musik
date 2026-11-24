package de.labtoso.musik

import android.media.AudioFormat
import android.media.AudioTrack
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The visualizer's ears: a copy of the sound the player itself decodes (songs and podcasts), taken
 * inside the player before it reaches the speaker. Nothing is recorded and no permission is needed.
 * The spectrum is worked out like the browser's AnalyserNode does it, so the bars look the same on
 * every device, and it is read at the moment the sound is actually heard (the audio buffer runs ahead).
 */
@OptIn(UnstableApi::class)
object VizTap : TeeAudioProcessor.AudioBufferSink {
    /** Only copy sound while a visualizer is on screen; switching on starts with fresh time marks. */
    @Volatile var wanted = false
        set(v) {
            if (v && !field) synchronized(lock) { marks.clear() }
            field = v
        }

    private const val FFT = 2048
    private const val RING = 1 shl 17 // about 2.7 s at 48 kHz
    private const val MASK = RING - 1
    private const val BANDS = 64
    // same scale as the browser's analyser (minDecibels / maxDecibels / smoothingTimeConstant)
    private const val MIN_DB = -100.0
    private const val MAX_DB = -30.0
    private const val SMOOTH = 0.55

    private val lock = Any()
    private val ring = FloatArray(RING)
    private var written = 0L
    private var rate = 44100
    private var channels = 2
    private var encoding = C.ENCODING_PCM_16BIT
    /** When which amount of sound went into the audio buffer: [System.nanoTime, samples written]. */
    private val marks = ArrayDeque<LongArray>()
    /** Paused until the player says it plays (a queue can be prepared while paused). */
    private var pausedAt = System.nanoTime()
    private var bufferNs = 250_000_000L

    private val window = DoubleArray(FFT) { i ->
        // Blackman, like the analyser
        val a = 2 * PI * i / FFT
        0.42 - 0.5 * cos(a) + 0.08 * cos(2 * a)
    }
    private val re = DoubleArray(FFT)
    private val im = DoubleArray(FFT)
    private val mag = DoubleArray(FFT / 2)
    private val rev = IntArray(FFT).also { r ->
        val bits = Integer.numberOfTrailingZeros(FFT)
        for (i in 0 until FFT) r[i] = Integer.reverse(i) ushr (32 - bits)
    }
    private val cosT = DoubleArray(FFT / 2) { cos(2 * PI * it / FFT) }
    private val sinT = DoubleArray(FFT / 2) { -sin(2 * PI * it / FFT) }

    override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
        synchronized(lock) {
            rate = if (sampleRateHz > 0) sampleRateHz else 44100
            channels = max(1, channelCount)
            this.encoding = encoding
            written = 0
            marks.clear()
            ring.fill(0f)
            mag.fill(0.0)
            bufferNs = trackBufferNs(rate, channels)
        }
    }

    override fun handleBuffer(buffer: ByteBuffer) {
        if (!wanted) return
        val b = buffer.duplicate().order(ByteOrder.nativeOrder())
        synchronized(lock) {
            val ch = channels
            when (encoding) {
                C.ENCODING_PCM_16BIT -> while (b.remaining() >= 2 * ch) {
                    var s = 0f
                    for (c in 0 until ch) s += b.short / 32768f
                    ring[(written and MASK.toLong()).toInt()] = s / ch
                    written++
                }
                C.ENCODING_PCM_FLOAT -> while (b.remaining() >= 4 * ch) {
                    var s = 0f
                    for (c in 0 until ch) s += b.float
                    ring[(written and MASK.toLong()).toInt()] = s / ch
                    written++
                }
                else -> return
            }
            // sound buffered while paused (seek, next song) starts playing at the resume: stamp it with the
            // pause time, playing(true) then moves it to the moment the sound really starts
            val clock = System.nanoTime()
            marks.addLast(longArrayOf(if (pausedAt != 0L) pausedAt else clock, written))
            while (marks.size > 2 && (marks.size > 400 || marks[1][0] < clock - 3_000_000_000L)) marks.removeFirst()
        }
    }

    /** The player paused or went on: the buffered sound waits too, so the time marks move with it. */
    fun playing(on: Boolean) {
        synchronized(lock) {
            val now = System.nanoTime()
            if (!on) {
                if (pausedAt == 0L) pausedAt = now
            } else if (pausedAt != 0L) {
                val d = now - pausedAt
                for (m in marks) m[0] += d
                pausedAt = 0L
            }
        }
    }

    /**
     * 64 levels (0..255, comma separated) of the sound that is heard right now, from 40 Hz to 16 kHz on
     * a log scale. Empty while there is nothing to show yet (start, seek, pause, foreign sound).
     */
    fun bands(): String {
        synchronized(lock) {
            if (pausedAt != 0L || marks.isEmpty()) return ""
            // the sound written to the buffer `bufferNs` ago is what plays now
            val target = System.nanoTime() - bufferNs
            if (marks.first()[0] > target) return ""
            var idx = written
            for (k in marks.indices.reversed()) {
                val m = marks[k]
                if (m[0] <= target) {
                    val next = if (k + 1 < marks.size) marks[k + 1][1] else written
                    idx = min(next, m[1] + ((target - m[0]) * rate / 1_000_000_000L))
                    break
                }
            }
            if (idx < FFT || written - idx > RING - FFT) return ""
            // window the last FFT samples before the heard moment
            val start = idx - FFT
            for (i in 0 until FFT) {
                val j = rev[i]
                re[j] = ring[((start + i) and MASK.toLong()).toInt()] * window[i]
                im[j] = 0.0
            }
            fft()
            for (k in 0 until FFT / 2) {
                val m = sqrt(re[k] * re[k] + im[k] * im[k]) / FFT
                mag[k] = SMOOTH * mag[k] + (1 - SMOOTH) * m
            }
            val hzPerBin = rate / 2.0 / (FFT / 2)
            val lo = ln(40.0)
            val hi = ln(16000.0)
            val n = FFT / 2
            val sb = StringBuilder(BANDS * 4)
            for (i in 0 until BANDS) {
                val f0 = exp(lo + (hi - lo) * i / BANDS)
                val f1 = exp(lo + (hi - lo) * (i + 1) / BANDS)
                val b0 = max(1, (f0 / hzPerBin).toInt())
                val b1 = min(n - 1, max(b0, Math.ceil(f1 / hzPerBin).toInt()))
                var peak = 0.0
                for (k in b0..b1) if (mag[k] > peak) peak = mag[k]
                val db = if (peak > 0) 20 * log10(peak) else MIN_DB
                val v = ((db - MIN_DB) / (MAX_DB - MIN_DB)).coerceIn(0.0, 1.0)
                if (i > 0) sb.append(',')
                sb.append((v * 255).toInt())
            }
            return sb.toString()
        }
    }

    /** In-place radix-2 FFT on re/im (input already in bit reversed order). */
    private fun fft() {
        var size = 2
        while (size <= FFT) {
            val half = size / 2
            val step = FFT / size
            var i = 0
            while (i < FFT) {
                var t = 0
                for (j in i until i + half) {
                    val wr = cosT[t]
                    val wi = sinT[t]
                    val xr = re[j + half] * wr - im[j + half] * wi
                    val xi = re[j + half] * wi + im[j + half] * wr
                    re[j + half] = re[j] - xr
                    im[j + half] = im[j] - xi
                    re[j] += xr
                    im[j] += xi
                    t += step
                }
                i += size
            }
            size *= 2
        }
    }

    /** How much sound the player keeps in its audio buffer (same rule as Media3's default sink). */
    private fun trackBufferNs(rate: Int, channels: Int): Long {
        val mask = if (channels >= 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
        val frame = 2 * min(2, channels)
        val minBytes = runCatching { AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT) }.getOrDefault(0)
        val minUs = if (minBytes > 0) minBytes.toLong() / frame * 1_000_000L / rate else 0L
        val us = (minUs * 4).coerceIn(250_000L, 750_000L)
        return us * 1000L
    }
}
