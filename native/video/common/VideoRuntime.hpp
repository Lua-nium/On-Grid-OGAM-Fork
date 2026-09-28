#pragma once
#ifdef __APPLE__
#include <OffgridVideoRuntime/stable-diffusion.h>
#else
#include "stable-diffusion.h"
#endif
#include <atomic>
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
};
// One instance per process. Both host bridges use the same native lifecycle.
class VideoRuntime {
  std::mutex contextMutex;
  std::mutex executionMutex;
  sd_ctx_t *context = nullptr;
public:
  std::atomic_bool cancelled{false};
  void cancel() {
    cancelled.store(true);
    std::lock_guard<std::mutex> guard(contextMutex);
    if (context) sd_cancel_generation(context, SD_CANCEL_ALL);
  }
  void run(const VideoRequest &request,
           const std::function<void(int, int)> &progress,
           const std::function<void(sd_image_t *, int, int)> &encode) {
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
      sd_ctx_params_t config;
      sd_ctx_params_init(&config);
      config.diffusion_model_path = request.weight.c_str();
      config.vae_path = request.vae.c_str();
      config.t5xxl_path = request.encoder.c_str();
      config.enable_mmap = true;
      config.diffusion_flash_attn = true;
      config.auto_fit = true;
      config.eager_load = false;
      config.n_threads = 4;
      auto loaded = new_sd_ctx(&config);
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
      params.sample_params.flow_shift = 3;
      params.sample_params.sample_method = EULER_SAMPLE_METHOD;
      params.sample_params.scheduler = sd_get_default_scheduler(loaded, EULER_SAMPLE_METHOD);
      params.vae_tiling_params.enabled = true;
      if (!generate_video(loaded, &params, &frames, &count, nullptr, &fps) || !frames || count == 0)
        throw std::runtime_error(cancelled.load() ? "Video generation stopped." : "The video engine produced no frames.");
      if (cancelled.load()) throw std::runtime_error("Video generation stopped.");
      encode(frames, count, fps);
    } catch (...) { cleanup(); throw; }
    cleanup();
  }
};
}
