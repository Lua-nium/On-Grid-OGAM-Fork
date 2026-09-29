#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>
#import <BackgroundTasks/BackgroundTasks.h>
#import "VideoEncoder.h"
#include "common/VideoRuntime.hpp"

@interface VideoGenerationModule : RCTEventEmitter <RCTBridgeModule>
@end
@implementation VideoGenerationModule {
  offgrid::VideoRuntime _runtime;
  dispatch_queue_t _worker;
  BOOL _busy;
  BOOL _listeners;
  NSString *_videoInterruptionReason;
  BGTask *_continued;
  NSString *_taskIdentifier;
  dispatch_block_t _continuedWork;
}
RCT_EXPORT_MODULE(VideoGenerationModule)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _worker = dispatch_queue_create("ai.offgrid.video", DISPATCH_QUEUE_SERIAL);

    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(backgrounded)
      name:UIApplicationDidEnterBackgroundNotification object:nil];
  }
  return self;
}
- (void)dealloc { [[NSNotificationCenter defaultCenter] removeObserver:self]; }
- (NSArray<NSString *> *)supportedEvents { return @[@"VideoGenerationProgress", @"SDImageProgress"]; }
- (void)startObserving { _listeners = YES; }
- (void)stopObserving { _listeners = NO; }
- (void)backgrounded {
  // Metal work must stop before the OS removes GPU access. Continued GPU tasks
  // are admitted separately by the background coordinator on supported systems.
  if (_busy && !_continued) {
    _videoInterruptionReason = @"Video generation stopped when the app went into the background. Keep Off Grid open and try again.";
    _runtime.cancel();
  }
}
- (void)emitStage:(NSString *)stage step:(int)step total:(int)total {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(iOS 26.0, *)) {
      if (self->_continued && total > 0) {
        BGContinuedProcessingTask *task = (BGContinuedProcessingTask *)self->_continued;
        task.progress.totalUnitCount = total + 2;
        task.progress.completedUnitCount = MIN(step + 1, total + 1);
        [task updateTitle:@"Generating video" subtitle:stage];
      }
    }
    if (self->_listeners) [self sendEventWithName:@"VideoGenerationProgress"
      body:@{@"stage":stage, @"step":@(step), @"total":@(total)}];
  });
}
RCT_REMAP_METHOD(cancel, cancelWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    self->_runtime.cancel();
    if (self->_continuedWork) {
      if (self->_taskIdentifier) [BGTaskScheduler.sharedScheduler cancelTaskRequestWithIdentifier:self->_taskIdentifier];
      dispatch_block_t pending = self->_continuedWork; self->_continuedWork = nil;
      pending(); // The worker observes cancellation and settles the JS promise.
    }
    resolve(nil);
  });
}
RCT_REMAP_METHOD(generate, generate:(NSDictionary *)input resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_busy) { reject(@"VIDEO_BUSY", @"Video generation is already running.", nil); return; }
    self->_busy = YES; self->_runtime.cancelled.store(false);
    self->_videoInterruptionReason = nil;
    [self startContinuedWork:^{
    dispatch_async(self->_worker, ^{
      @autoreleasepool {
        NSString *output = input[@"outputPath"];
        NSError *failure = nil;
        try {
          offgrid::VideoRequest request{
            [input[@"weight"] UTF8String], [input[@"vae"] UTF8String], [(input[@"encoder"] ?: @"") UTF8String],
            [input[@"prompt"] UTF8String], [input[@"negativePrompt"] UTF8String],
            [input[@"width"] intValue], [input[@"height"] intValue], [input[@"frames"] intValue],
            [input[@"fps"] intValue], [input[@"steps"] intValue], [input[@"guidance"] floatValue], [input[@"seed"] longLongValue]
          };
          request.llm = [(input[@"llm"] ?: @"") UTF8String];
          request.embeddings = [(input[@"embeddings"] ?: @"") UTF8String];
          request.audioVae = [(input[@"audioVae"] ?: @"") UTF8String];
          request.flowShift = [input[@"flowShift"] floatValue];
          [self emitStage:@"preparing" step:0 total:request.steps];
          self->_runtime.run(request, [&](int step, int total) {
            [self emitStage:@"generating" step:step total:total];
          }, [&](sd_image_t *frames, int count, int fps) {
            [self emitStage:@"encoding" step:count total:count];
            NSError *encodingError = nil;
            if (!OGEncodeVideo(frames, count, fps, output, self->_runtime.cancelled, &encodingError))
              throw std::runtime_error(encodingError ? encodingError.localizedDescription.UTF8String : "Video encoding stopped.");
          }, [&](const char *) { [self emitStage:@"conditioning" step:0 total:0]; });
        } catch (const std::exception &error) {
          failure = [NSError errorWithDomain:@"OffgridVideo" code:1 userInfo:@{NSLocalizedDescriptionKey:@(error.what())}];
          [[NSFileManager defaultManager] removeItemAtPath:output error:nil];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          self->_busy = NO;
          if (self->_continued) {
            [self->_continued setTaskCompletedWithSuccess:failure == nil]; self->_continued = nil;
          }
          if (failure && self->_videoInterruptionReason)
            reject(@"VIDEO_BACKGROUND_INTERRUPTED", self->_videoInterruptionReason, failure);
          else if (failure) reject(self->_runtime.cancelled.load() ? @"VIDEO_CANCELLED" : @"VIDEO_FAILED", failure.localizedDescription, failure);
          else resolve(@{@"path":output});
        });
      }
    });
    }];
  });
}
RCT_REMAP_METHOD(getLoadedImagePath, imagePathWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  auto path = _runtime.loadedImagePath(); resolve(path.empty() ? nil : @(path.c_str()));
}
RCT_REMAP_METHOD(loadImageModel, loadImage:(NSDictionary *)input resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_busy) { reject(@"IMAGE_BUSY", @"Image or video generation is running.", nil); return; }
    self->_busy = YES; self->_runtime.cancelled.store(false);
    dispatch_async(self->_worker, ^{
      NSString *failure = nil;
      try {
        offgrid::VideoRequest request{};
        request.weight = [input[@"weight"] UTF8String]; request.vae = [input[@"vae"] UTF8String];
        request.llm = [input[@"llm"] UTF8String]; request.threads = [input[@"threads"] intValue]; request.cpuOnly = [input[@"cpuOnly"] boolValue];
        self->_runtime.loadImage(request, [input[@"modelPath"] UTF8String]);
      } catch (const std::exception &error) { failure = @(error.what()); }
      dispatch_async(dispatch_get_main_queue(), ^{
        self->_busy = NO;
        if (failure) reject(@"IMAGE_LOAD_FAILED", failure, nil); else resolve(@YES);
      });
    });
  });
}
RCT_REMAP_METHOD(unloadImageModel, unloadImageWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_busy) { reject(@"IMAGE_BUSY", @"Image or video generation is running.", nil); return; }
    self->_busy = YES;
    dispatch_async(self->_worker, ^{
      NSString *failure = nil;
      try { self->_runtime.unloadImage(); } catch (const std::exception &error) { failure = @(error.what()); }
      dispatch_async(dispatch_get_main_queue(), ^{
        self->_busy = NO;
        if (failure) reject(@"IMAGE_UNLOAD_FAILED", failure, nil); else resolve(@YES);
      });
    });
  });
}
RCT_REMAP_METHOD(generateImage, generateImage:(NSDictionary *)input resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self->_busy) { reject(@"IMAGE_BUSY", @"Image or video generation is running.", nil); return; }
    self->_busy = YES; self->_runtime.cancelled.store(false);
    dispatch_async(self->_worker, ^{
      @autoreleasepool {
        NSString *output = input[@"outputPath"];
        NSString *failure = nil;
        try {
          offgrid::VideoRequest request{};
          request.prompt = [input[@"prompt"] UTF8String]; request.negative = [input[@"negativePrompt"] UTF8String];
          request.width = [input[@"width"] intValue]; request.height = [input[@"height"] intValue];
          request.steps = [input[@"steps"] intValue]; request.guidance = [input[@"guidanceScale"] floatValue]; request.seed = [input[@"seed"] longLongValue];
          if (request.width < 64 || request.width > 2048 || request.height < 64 || request.height > 2048 || request.width % 16 || request.height % 16)
            throw std::runtime_error("Image dimensions are not supported.");
          self->_runtime.image(request, [&](int step, int total) {
            dispatch_async(dispatch_get_main_queue(), ^{
              if (self->_listeners) [self sendEventWithName:@"SDImageProgress" body:@{@"step":@(step), @"totalSteps":@(total), @"progress":@(total > 0 ? double(step) / total : 0)}];
            });
          }, [&](const sd_image_t &image) {
            if (!image.data || image.channel != 3 || image.width != request.width || image.height != request.height)
              throw std::runtime_error("The image engine returned invalid pixels.");
            CFDataRef data = CFDataCreate(kCFAllocatorDefault, image.data, image.width * image.height * 3);
            CGDataProviderRef provider = data ? CGDataProviderCreateWithCFData(data) : nullptr;
            CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
            CGImageRef bitmap = provider ? CGImageCreate(image.width, image.height, 8, 24, image.width * 3, color, kCGImageAlphaNone, provider, nullptr, false, kCGRenderingIntentDefault) : nullptr;
            NSData *png = bitmap ? UIImagePNGRepresentation([UIImage imageWithCGImage:bitmap]) : nil;
            if (bitmap) CGImageRelease(bitmap);
            CGColorSpaceRelease(color); if (provider) CGDataProviderRelease(provider); if (data) CFRelease(data);
            if (!png || ![png writeToFile:output atomically:YES]) throw std::runtime_error("Could not save the image.");
          });
          if (self->_runtime.cancelled.load()) throw std::runtime_error("Image generation stopped.");
        } catch (const std::exception &error) {
          failure = @(error.what()); [[NSFileManager defaultManager] removeItemAtPath:output error:nil];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          self->_busy = NO;
          if (failure) reject(@"IMAGE_FAILED", failure, nil);
          else resolve(@{@"id":input[@"id"], @"imagePath":output, @"width":input[@"width"], @"height":input[@"height"], @"seed":input[@"seed"]});
        });
      }
    });
  });
}
- (void)startContinuedWork:(dispatch_block_t)work {
  _continuedWork = [work copy];
  if (@available(iOS 26.0, *)) {
    if (BGTaskScheduler.supportedResources & BGContinuedProcessingTaskRequestResourcesGPU) {
      if (!_taskIdentifier) {
        _taskIdentifier = [NSString stringWithFormat:@"%@.video.generation", NSBundle.mainBundle.bundleIdentifier];
        __weak VideoGenerationModule *weakSelf = self;
        BOOL registered = [BGTaskScheduler.sharedScheduler registerForTaskWithIdentifier:_taskIdentifier usingQueue:dispatch_get_main_queue() launchHandler:^(BGTask *task) {
          VideoGenerationModule *owner = weakSelf;
          if (!owner || !owner->_busy) { [task setTaskCompletedWithSuccess:NO]; return; }
          owner->_continued = task;
          __weak BGTask *expiringTask = task;
          task.expirationHandler = ^{
            dispatch_async(dispatch_get_main_queue(), ^{
              VideoGenerationModule *active = weakSelf;
              if (active && active->_continued == expiringTask && active->_busy) {
                active->_videoInterruptionReason = @"iOS stopped background video generation. Keep Off Grid open and try again.";
                active->_runtime.cancel();
              }
            });
          };
          dispatch_block_t admitted = owner->_continuedWork; owner->_continuedWork = nil;
          if (admitted) admitted();
        }];
        if (!registered) { _taskIdentifier = nil; _continuedWork = nil; work(); return; }
      }
      BGContinuedProcessingTaskRequest *request = [[BGContinuedProcessingTaskRequest alloc] initWithIdentifier:_taskIdentifier title:@"Generating video" subtitle:@"Loading model"];
      request.requiredResources = BGContinuedProcessingTaskRequestResourcesGPU;
      request.strategy = BGContinuedProcessingTaskRequestSubmissionStrategyFail;
      if ([BGTaskScheduler.sharedScheduler submitTaskRequest:request error:nil]) return;
    }
  }
  _continuedWork = nil;
  work();
}
@end
