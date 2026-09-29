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
- (NSArray<NSString *> *)supportedEvents { return @[@"VideoGenerationProgress"]; }
- (void)startObserving { _listeners = YES; }
- (void)stopObserving { _listeners = NO; }
- (void)backgrounded {
  // Metal work must stop before the OS removes GPU access. Continued GPU tasks
  // are admitted separately by the background coordinator on supported systems.
  if (_busy && !_continued) _runtime.cancel();
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
          });
        } catch (const std::exception &error) {
          failure = [NSError errorWithDomain:@"OffgridVideo" code:1 userInfo:@{NSLocalizedDescriptionKey:@(error.what())}];
          [[NSFileManager defaultManager] removeItemAtPath:output error:nil];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          self->_busy = NO;
          if (self->_continued) {
            [self->_continued setTaskCompletedWithSuccess:failure == nil]; self->_continued = nil;
          }
          if (failure) reject(self->_runtime.cancelled.load() ? @"VIDEO_CANCELLED" : @"VIDEO_FAILED", failure.localizedDescription, failure);
          else resolve(@{@"path":output});
        });
      }
    });
    }];
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
          task.expirationHandler = ^{ VideoGenerationModule *active = weakSelf; if (active) active->_runtime.cancel(); };
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
