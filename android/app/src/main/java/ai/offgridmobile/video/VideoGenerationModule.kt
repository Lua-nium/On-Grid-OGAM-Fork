package ai.offgridmobile.video

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class VideoGenerationModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    companion object { init { System.loadLibrary("offgrid_video") } }
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)
    private var encoder: VideoEncoder? = null
    override fun getName() = "VideoGenerationModule"
    private external fun nativeGenerate(weight: String, vae: String, encoder: String, prompt: String, negative: String, width: Int, height: Int, frames: Int, fps: Int, steps: Int, guidance: Double, seed: Double)
    private external fun nativeCancel()
    private external fun nativePrepare()
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    private fun stop() { cancelled.set(true); nativeCancel() }
    @ReactMethod fun cancel(promise: Promise) { stop(); promise.resolve(null) }
    // Called synchronously by JNI while its worker owns the runtime.
    fun progress(step: Int, total: Int) {
        emit("generating", step, total)
    }
    fun frame(rgb: ByteArray, width: Int, height: Int, channels: Int) {
        check(!cancelled.get()) { "Video generation stopped." }
        emit("encoding", 0, 0)
        checkNotNull(encoder).append(rgb, channels) { cancelled.get() }
    }
    private fun emit(stage: String, step: Int, total: Int) {
        if (!context.hasActiveReactInstance()) return
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("VideoGenerationProgress", Arguments.createMap().apply { putString("stage", stage); putInt("step", step); putInt("total", total) })
    }
    @ReactMethod fun generate(input: ReadableMap, promise: Promise) {
        if (!busy.compareAndSet(false, true)) { promise.reject("VIDEO_BUSY", "Video generation is already running."); return }
        cancelled.set(false); nativePrepare()
        executor.execute {
            var output: File? = null
            try {
                val destination = File(checkNotNull(input.getString("outputPath")))
                output = destination
                VideoGenerationService.admission = CompletableFuture()
                VideoGenerationService.cancel = { stop() }
                ContextCompat.startForegroundService(context, Intent(context, VideoGenerationService::class.java))
                VideoGenerationService.admission.get(5, TimeUnit.SECONDS)
                check(!cancelled.get()) { "Video generation stopped." }
                emit("preparing", 0, input.getInt("steps"))
                VideoEncoder(destination.path, input.getInt("width"), input.getInt("height"), input.getInt("fps")).use { writer ->
                    encoder = writer
                    nativeGenerate(checkNotNull(input.getString("weight")), checkNotNull(input.getString("vae")), checkNotNull(input.getString("encoder")),
                        checkNotNull(input.getString("prompt")), input.getString("negativePrompt") ?: "", input.getInt("width"), input.getInt("height"),
                        input.getInt("frames"), input.getInt("fps"), input.getInt("steps"), input.getDouble("guidance"), input.getDouble("seed"))
                    writer.finish { cancelled.get() }
                }
                check(destination.length() > 0) { "Video encoder produced no file." }
                promise.resolve(Arguments.createMap().apply { putString("path", destination.path) })
            } catch (error: Throwable) {
                output?.delete(); promise.reject(if (cancelled.get()) "VIDEO_CANCELLED" else "VIDEO_FAILED", error.message, error)
            } finally {
                encoder = null; VideoGenerationService.cancel = null
                context.stopService(Intent(context, VideoGenerationService::class.java)); busy.set(false)
            }
        }
    }
    override fun invalidate() { stop(); executor.shutdown(); super.invalidate() }
}
