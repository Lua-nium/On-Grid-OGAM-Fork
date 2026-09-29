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
    private external fun nativeGenerate(weight: String, vae: String, encoder: String, prompt: String, negative: String, width: Int, height: Int, frames: Int, fps: Int, steps: Int, guidance: Double, seed: Double, llm: String, embeddings: String, audioVae: String, flowShift: Double)
    private external fun nativeCancel()
    private external fun nativePrepare()
    private external fun nativeSetRuntimeDirectory(path: String)
    private fun prepareHexagonRuntime() {
        val directory = File(context.filesDir, "video-hexagon").apply { mkdirs() }
        val names = context.assets.list("video-hexagon") ?: emptyArray()
        check(names.isNotEmpty()) { "The video NPU runtime is missing from this build." }
        for (name in names) {
            check(name.matches(Regex("liboffgrid-video-htp-v[0-9]+\\.so")))
            val temporary = File(directory, "$name.tmp")
            context.assets.open("video-hexagon/$name").use { input ->
                temporary.outputStream().use { output -> input.copyTo(output) }
            }
            check(temporary.renameTo(File(directory, name))) { "Could not install the video NPU runtime." }
        }
        nativeSetRuntimeDirectory(directory.absolutePath)
    }
    @ReactMethod fun addListener(name: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
    private fun stop() { cancelled.set(true); nativeCancel() }
    @ReactMethod fun cancel(promise: Promise) { stop(); promise.resolve(null) }
    // Called synchronously by JNI while its worker owns the runtime.
    fun conditioning(backend: String) { emit("conditioning", 0, 0, backend) }
    fun progress(step: Int, total: Int) {
        emit("generating", step, total)
    }
    fun frame(rgb: ByteArray, width: Int, height: Int, channels: Int) {
        check(!cancelled.get()) { "Video generation stopped." }
        emit("encoding", 0, 0)
        checkNotNull(encoder).append(rgb, channels) { cancelled.get() }
    }
    private fun emit(stage: String, step: Int, total: Int, backend: String? = null) {
        if (!context.hasActiveReactInstance()) return
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("VideoGenerationProgress", Arguments.createMap().apply { putString("stage", stage); putInt("step", step); putInt("total", total); if (backend != null) putString("backend", backend) })
    }
    @ReactMethod fun generate(input: ReadableMap, promise: Promise) {
        if (!busy.compareAndSet(false, true)) { promise.reject("VIDEO_BUSY", "Video generation is already running."); return }
        cancelled.set(false); nativePrepare()
        executor.execute {
            var output: File? = null
            try {
                prepareHexagonRuntime()
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
                    nativeGenerate(checkNotNull(input.getString("weight")), checkNotNull(input.getString("vae")), if (input.hasKey("encoder")) input.getString("encoder") ?: "" else "",
                        checkNotNull(input.getString("prompt")), input.getString("negativePrompt") ?: "", input.getInt("width"), input.getInt("height"),
                        input.getInt("frames"), input.getInt("fps"), input.getInt("steps"), input.getDouble("guidance"), input.getDouble("seed"),
                        if (input.hasKey("llm")) input.getString("llm") ?: "" else "",
                        if (input.hasKey("embeddings")) input.getString("embeddings") ?: "" else "",
                        if (input.hasKey("audioVae")) input.getString("audioVae") ?: "" else "",
                        input.getDouble("flowShift"))
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
