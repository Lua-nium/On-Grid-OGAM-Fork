#pragma once
#ifdef __APPLE__
#include <OffgridVideoRuntime/stable-diffusion.h>
#else
#include "stable-diffusion.h"
#include "ggml-backend.h"
#endif
#include <atomic>
#include <limits>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <string>

namespace offgrid {
struct VideoRequest {
  std::string weight, vae, encoder, prompt, negative;
  int width, height, frames, fps, steps;
  float guidance;
  int64_t seed;
  std::string llm, embeddings, audioVae;
  float flowShift = 0;
  bool cpuOnly = false;
  int threads = 4;
};
// One instance per process. Both host bridges use the same native lifecycle.
class VideoRuntime {
  std::mutex contextMutex;
  std::mutex executionMutex;
  sd_ctx_t *context = nullptr;
  sd_ctx_t *imageContext = nullptr;
  std::string imagePath;
  sd_ctx_t *loadContext(const VideoRequest &request, std::string &preferred) {
      sd_ctx_params_t config;
      sd_ctx_params_init(&config);
      config.diffusion_model_path = request.weight.c_str();
      config.vae_path = request.vae.c_str();
      config.t5xxl_path = request.encoder.c_str();
      config.llm_path = request.llm.c_str();
      config.embeddings_connectors_path = request.embeddings.c_str();
      config.audio_vae_path = request.audioVae.c_str();
      config.enable_mmap = true;
      config.diffusion_flash_attn = true;
      config.auto_fit = true;
      config.eager_load = false;
#ifdef __ANDROID__
      // Probe the NPU before choosing it. Devices without a usable Hexagon
      // runtime retain Vulkan diffusion and the CPU conditioning fallback.
      sd_list_devices(nullptr, 0);

      for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        auto device = ggml_backend_dev_get(i);
        const char *name = ggml_backend_dev_name(device);
        if (request.cpuOnly || std::string(name).rfind("HTP", 0) != 0) continue;
        try {
          auto probe = ggml_backend_dev_init(device, nullptr);
          if (!probe) continue;
          preferred = name;
          ggml_backend_free(probe);
          break;
        } catch (const std::exception &) {
          // An installed driver can still reject the DSP session.
        }
      }
      // Convolution-heavy decoders cannot execute their main operations on
      // Hexagon. Keep them on the GPU to avoid repeated GPU/NPU copies.
      const std::string npuBackend = preferred + (ggml_backend_dev_by_name("Vulkan0") ? ",vae=Vulkan0" : ",vae=cpu");
      config.backend = preferred.empty() ? "Vulkan0,te=cpu" : npuBackend.c_str();
      // Stream NPU weights from disk per graph segment. Keeping a second
      // complete copy on Vulkan retains the text encoder during diffusion and
      // can trigger Android's low-memory killer. The graph cap still controls
      // staging even though explicit disk placement disables auto-fit.
      if (!preferred.empty()) {
        config.params_backend = "disk";
        config.auto_fit = false;
      }
      config.max_vram = "HTP0=1.5";
      config.disable_prefetch = true;
#endif
      config.n_threads = request.threads;
      if (request.cpuOnly) {
        config.backend = "cpu"; config.params_backend = nullptr; config.auto_fit = true;
#ifdef __ANDROID__
        preferred.clear();
#endif
      }
      sd_ctx_t *loaded = nullptr;
#ifdef __ANDROID__
      try { loaded = new_sd_ctx(&config); }
      catch (const std::exception &) {
        if (request.cpuOnly || cancelled.load()) throw;
      }
      if (!loaded && !preferred.empty() && !cancelled.load()) {
        preferred.clear();
        config.params_backend = nullptr;
        config.auto_fit = true;
        config.backend = "Vulkan0,te=cpu";
        try { loaded = new_sd_ctx(&config); }
        catch (const std::exception &) {
          if (cancelled.load()) throw;
        }
      }
      if (!loaded && !cancelled.load()) {
        config.backend = "cpu";
        loaded = new_sd_ctx(&config);
      }
#else
      loaded = new_sd_ctx(&config);
#endif
      return loaded;
  }
public:
  ~VideoRuntime() {
    if (context) free_sd_ctx(context);
    if (imageContext) free_sd_ctx(imageContext);
  }
  std::atomic_bool cancelled{false};
  void cancel() {
    cancelled.store(true);
    std::lock_guard<std::mutex> guard(contextMutex);
    if (context) sd_cancel_generation(context, SD_CANCEL_ALL);
    if (imageContext) sd_cancel_generation(imageContext, SD_CANCEL_ALL);
  }
  void loadImage(const VideoRequest &request, const std::string &path) {
    std::unique_lock<std::mutex> execution(executionMutex, std::try_to_lock);
    if (!execution.owns_lock()) throw std::runtime_error("Image or video generation is running.");
    {
      std::lock_guard<std::mutex> guard(contextMutex);
      if (imageContext) free_sd_ctx(imageContext);
      imageContext = nullptr; imagePath.clear();
    }
    std::string preferred;
    auto loaded = loadContext(request, preferred);
    if (!loaded) throw std::runtime_error("Could not load the image model pack.");
    std::lock_guard<std::mutex> guard(contextMutex);
    if (cancelled.load()) { free_sd_ctx(loaded); throw std::runtime_error("Image loading stopped."); }
    imageContext = loaded; imagePath = path;
  }
  void unloadImage() {
    std::unique_lock<std::mutex> execution(executionMutex, std::try_to_lock);
    if (!execution.owns_lock()) throw std::runtime_error("Image or video generation is running.");
    std::lock_guard<std::mutex> guard(contextMutex);
    if (imageContext) free_sd_ctx(imageContext);
    imageContext = nullptr; imagePath.clear();
  }
  std::string loadedImagePath() {
    std::lock_guard<std::mutex> guard(contextMutex);
    return imageContext ? imagePath : "";
  }
  void image(const VideoRequest &request,
             const std::function<void(int, int)> &progress,
             const std::function<void(const sd_image_t &)> &save) {
    std::unique_lock<std::mutex> execution(executionMutex, std::try_to_lock);
    if (!execution.owns_lock()) throw std::runtime_error("Image or video generation is running.");
    if (!imageContext) throw std::runtime_error("Image model is unloaded.");
    sd_image_t *images = nullptr; int count = 0;
    auto cleanup = [&] {
      sd_set_progress_callback(nullptr, nullptr);
      if (images) free_sd_images(images, count);
    };
    try {
      if (cancelled.load()) throw std::runtime_error("Image generation stopped.");
      sd_set_progress_callback([](int step, int total, float, void *data) {
        (*static_cast<const std::function<void(int, int)> *>(data))(step, total);
      }, const_cast<void *>(static_cast<const void *>(&progress)));
      sd_img_gen_params_t params; sd_img_gen_params_init(&params);
      params.prompt = request.prompt.c_str(); params.negative_prompt = request.negative.c_str();
      params.width = request.width; params.height = request.height; params.seed = request.seed;
      params.batch_count = 1;
      params.sample_params.sample_steps = request.steps;
      params.sample_params.guidance.txt_cfg = request.guidance;
      params.sample_params.sample_method = EULER_SAMPLE_METHOD;
      params.sample_params.scheduler = sd_get_default_scheduler(imageContext, EULER_SAMPLE_METHOD);
      params.vae_tiling_params.enabled = true;
      if (!generate_image(imageContext, &params, &images, &count) || !images || count != 1)
        throw std::runtime_error("The image engine produced no image.");
      if (cancelled.load()) throw std::runtime_error("Image generation stopped.");
      save(images[0]);
    } catch (...) { cleanup(); throw; }
    cleanup();
  }
  void run(const VideoRequest &request,
           const std::function<void(int, int)> &progress,
           const std::function<void(sd_image_t *, int, int)> &encode,
           const std::function<void(const char *)> &conditioning) {
    std::unique_lock<std::mutex> execution(executionMutex, std::try_to_lock);
    if (!execution.owns_lock()) throw std::runtime_error("Video generation is already running.");
    sd_image_t *frames = nullptr;
    int count = 0, fps = request.fps;
    auto cleanup = [&] {
      if (frames) free_sd_images(frames, count);
      sd_set_progress_callback(nullptr, nullptr);
      std::lock_guard<std::mutex> guard(contextMutex);
      if (context) free_sd_ctx(context);
      context = nullptr;
    };
    try {
      if (cancelled.load()) throw std::runtime_error("Video generation stopped.");
      std::string preferred;
      sd_ctx_t *loaded = loadContext(request, preferred);
      {
        std::lock_guard<std::mutex> guard(contextMutex);
        context = loaded;
      }
      if (!loaded) throw std::runtime_error("Could not load the video model pack.");
      if (cancelled.load()) throw std::runtime_error("Video generation stopped.");
      sd_set_progress_callback([](int step, int total, float, void *data) {
        (*static_cast<const std::function<void(int, int)> *>(data))(step, total);
      }, const_cast<void *>(static_cast<const void *>(&progress)));
      sd_vid_gen_params_t params;
      sd_vid_gen_params_init(&params);
      params.prompt = request.prompt.c_str(); params.negative_prompt = request.negative.c_str();
      params.width = request.width; params.height = request.height;
      params.video_frames = request.frames; params.fps = request.fps; params.seed = request.seed;
      params.sample_params.sample_steps = request.steps;
      params.sample_params.guidance.txt_cfg = request.guidance;
      params.sample_params.flow_shift = request.flowShift > 0 ? request.flowShift : std::numeric_limits<float>::infinity();
      params.sample_params.sample_method = EULER_SAMPLE_METHOD;
      params.sample_params.scheduler = sd_get_default_scheduler(loaded, EULER_SAMPLE_METHOD);
      params.vae_tiling_params.enabled = true;
#ifdef __ANDROID__
      // Mobile Vulkan drivers can lose the device on a full temporal decode.
      // Keep each decode graph small instead of waiting for allocation failure:
      // a lost GPU cannot recover through the allocator's tiling retry.
      params.vae_tiling_params.temporal_tiling = true;
      params.vae_tiling_params.tile_size_w = 128;
      params.vae_tiling_params.tile_size_h = 128;
      params.vae_tiling_params.extra_tiling_args = "temporal_tile_frames=1";
      conditioning(preferred.empty() ? "cpu" : "npu");
#else
      conditioning("");
#endif
      if (!generate_video(loaded, &params, &frames, &count, nullptr, &fps) || !frames || count == 0)
        throw std::runtime_error(cancelled.load() ? "Video generation stopped." : "The video engine produced no frames.");
      if (cancelled.load()) throw std::runtime_error("Video generation stopped.");
      encode(frames, count, fps);
    } catch (...) { cleanup(); throw; }
    cleanup();
  }
};
}
