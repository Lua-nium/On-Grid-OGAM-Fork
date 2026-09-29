#include <jni.h>
#include <limits>
#include "VideoRuntime.hpp"

static offgrid::VideoRuntime runtime;

class AttachedEnv {
  JavaVM *vm;
  bool attached = false;
public:
  JNIEnv *env = nullptr;
  explicit AttachedEnv(JavaVM *value) : vm(value) {
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
      attached = vm->AttachCurrentThread(&env, nullptr) == JNI_OK;
      if (!attached) env = nullptr;
    }
  }
  ~AttachedEnv() { if (attached) vm->DetachCurrentThread(); }
};

static std::string string(JNIEnv *env, jstring value) {
  if (!value) throw std::runtime_error("Missing video argument.");
  const char *bytes = env->GetStringUTFChars(value, nullptr);
  if (!bytes) throw std::runtime_error("Missing video argument.");
  std::string result(bytes);
  env->ReleaseStringUTFChars(value, bytes);
  return result;
}

extern "C" JNIEXPORT void JNICALL Java_ai_offgridmobile_video_VideoGenerationModule_nativePrepare(JNIEnv *, jobject) { runtime.cancelled.store(false); }
extern "C" JNIEXPORT void JNICALL Java_ai_offgridmobile_video_VideoGenerationModule_nativeCancel(JNIEnv *, jobject) { runtime.cancel(); }
extern "C" JNIEXPORT void JNICALL Java_ai_offgridmobile_video_VideoGenerationModule_nativeGenerate(
  JNIEnv *env, jobject self, jstring weight, jstring vae, jstring encoder, jstring prompt, jstring negative,
  jint width, jint height, jint frames, jint fps, jint steps, jdouble guidance, jdouble seed, jstring llm, jstring embeddings, jstring audioVae, jdouble flowShift) {
  jobject owner = nullptr;
  try {
    offgrid::VideoRequest request{string(env, weight), string(env, vae), string(env, encoder), string(env, prompt), string(env, negative), width, height, frames, fps, steps, (float)guidance, (int64_t)seed};
    request.llm = string(env, llm);
    request.embeddings = string(env, embeddings);
    request.audioVae = string(env, audioVae);
    request.flowShift = (float)flowShift;
    JavaVM *vm = nullptr;
    if (env->GetJavaVM(&vm) != JNI_OK) throw std::runtime_error("Could not access the video host.");
    owner = env->NewGlobalRef(self);
    if (!owner) throw std::runtime_error("Not enough memory to start video generation.");
    auto klass = env->GetObjectClass(self);
    auto progress = env->GetMethodID(klass, "progress", "(II)V");
    auto frame = env->GetMethodID(klass, "frame", "([BIII)V");
    env->DeleteLocalRef(klass);
    if (!progress || !frame) throw std::runtime_error("Missing video host callbacks.");
    std::atomic_bool callbackFailed{false};
    runtime.run(request, [&](int step, int total) {
      // The engine may report progress from a worker thread. JNI environments
      // are thread-local; never retain the caller's environment in this callback.
      AttachedEnv thread(vm);
      if (!thread.env) { callbackFailed.store(true); runtime.cancel(); return; }
      thread.env->CallVoidMethod(owner, progress, step, total);
      if (thread.env->ExceptionCheck()) {
        thread.env->ExceptionClear();
        callbackFailed.store(true);
        runtime.cancel();
      }
    }, [&](sd_image_t *images, int count, int) {
      if (callbackFailed.load()) throw std::runtime_error("Could not report video progress.");
      for (int i = 0; i < count; ++i) {
        if (runtime.cancelled.load()) throw std::runtime_error("Video generation stopped.");
        auto &image = images[i];
        const uint64_t size = uint64_t(image.width) * image.height * image.channel;
        if (!image.data || image.width != uint32_t(width) || image.height != uint32_t(height) ||
            image.channel != 3 || size > uint64_t(std::numeric_limits<jsize>::max()))
          throw std::runtime_error("The video engine returned an invalid frame.");
        auto bytes = env->NewByteArray(static_cast<jsize>(size));
        if (!bytes) throw std::runtime_error("Not enough memory to encode video.");
        env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(size), reinterpret_cast<jbyte *>(image.data));
        if (!env->ExceptionCheck()) env->CallVoidMethod(owner, frame, bytes, image.width, image.height, image.channel);
        env->DeleteLocalRef(bytes);
        if (env->ExceptionCheck()) throw std::runtime_error("Video encoder failed.");
      }
    });
  } catch (const std::exception &error) {
    if (!env->ExceptionCheck()) {
      auto klass = env->FindClass("java/lang/IllegalStateException");
      if (klass) { env->ThrowNew(klass, error.what()); env->DeleteLocalRef(klass); }
    }
  }
  if (owner) env->DeleteGlobalRef(owner);
}
