#import <React/RCTEventEmitter.h>
@import AVFoundation;
@import Speech;

static const NSTimeInterval GLWSilence = 2.0;
static const NSTimeInterval GLWNoSpeech = 6.0;
// After the audio ends, the recognizer sends its final result. This bounds the
// wait if it never does.
static const NSTimeInterval GLWFinalResult = 1.5;

@interface GLWDictation : RCTEventEmitter
@end

@implementation GLWDictation {
  AVAudioEngine *_engine;
  SFSpeechAudioBufferRecognitionRequest *_request;
  SFSpeechRecognitionTask *_task;
  NSUInteger _session;
  NSUInteger _silence;
}

RCT_EXPORT_MODULE(Dictation)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// Audio session and engine calls can block, so they stay off the main thread.
- (dispatch_queue_t)methodQueue
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("glow.dictation", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"dictationText", @"dictationEnd" ];
}

RCT_EXPORT_METHOD(start : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
      reject(@"denied", @"Speech recognition is off for Glow. You can turn it on in Settings.", nil);
      return;
    }
    [AVAudioSession.sharedInstance requestRecordPermission:^(BOOL granted) {
      dispatch_async(self.methodQueue, ^{
        if (!granted) {
          reject(@"denied", @"Microphone access is off for Glow. You can turn it on in Settings.", nil);
          return;
        }
        NSError *error = [self begin];
        if (error) {
          reject(@"unavailable", error.localizedDescription, error);
        } else {
          resolve(nil);
        }
      });
    }];
  }];
}

RCT_EXPORT_METHOD(stop)
{
  [self wrapUp];
}

- (NSError *)begin
{
  if (_engine) {
    return nil;
  }
  SFSpeechRecognizer *recognizer = [SFSpeechRecognizer new];
  if (!recognizer.isAvailable) {
    return [NSError errorWithDomain:@"Dictation"
                               code:1
                           userInfo:@{NSLocalizedDescriptionKey : @"Dictation is unavailable right now."}];
  }
  NSError *error;
  AVAudioSession *audio = AVAudioSession.sharedInstance;
  if (![audio setCategory:AVAudioSessionCategoryRecord
                     mode:AVAudioSessionModeMeasurement
                  options:AVAudioSessionCategoryOptionDuckOthers
                    error:&error] ||
      ![audio setActive:YES error:&error]) {
    return error;
  }
  SFSpeechAudioBufferRecognitionRequest *request = [SFSpeechAudioBufferRecognitionRequest new];
  request.shouldReportPartialResults = YES;
  request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition;
  request.addsPunctuation = YES;
  AVAudioEngine *engine = [AVAudioEngine new];
  AVAudioInputNode *input = engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  // Installing a tap on a format with no channels raises an exception.
  if (format.channelCount == 0) {
    [audio setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    return [NSError errorWithDomain:@"Dictation"
                               code:2
                           userInfo:@{NSLocalizedDescriptionKey : @"No microphone is available right now."}];
  }
  [input installTapOnBus:0
              bufferSize:1024
                  format:format
                   block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                     [request appendAudioPCMBuffer:buffer];
                   }];
  [engine prepare];
  if (![engine startAndReturnError:&error]) {
    [input removeTapOnBus:0];
    [audio setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    return error;
  }
  _engine = engine;
  _request = request;
  NSUInteger session = ++_session;
  __weak GLWDictation *weakSelf = self;
  dispatch_queue_t queue = self.methodQueue;
  _task = [recognizer recognitionTaskWithRequest:request
                                   resultHandler:^(SFSpeechRecognitionResult *result, NSError *taskError) {
                                     dispatch_async(queue, ^{
                                       [weakSelf session:session result:result error:taskError];
                                     });
                                   }];
  [self wrapUpAfter:GLWNoSpeech];
  return nil;
}

- (void)session:(NSUInteger)session result:(SFSpeechRecognitionResult *)result error:(NSError *)error
{
  if (session != _session || !_engine) {
    return;
  }
  if (result) {
    [self sendEventWithName:@"dictationText" body:result.bestTranscription.formattedString];
  }
  if (result.isFinal || error) {
    [self finish];
  } else if (_request) {
    [self wrapUpAfter:GLWSilence];
  }
}

- (void)wrapUpAfter:(NSTimeInterval)delay
{
  NSUInteger mark = ++_silence;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), self.methodQueue, ^{
    if (mark == self->_silence) {
      [self wrapUp];
    }
  });
}

// The request, not the engine, marks a running dictation: iOS stops the engine
// itself on an interruption or a route change.
- (void)wrapUp
{
  if (!_request) {
    return;
  }
  ++_silence;
  [_engine stop];
  [_engine.inputNode removeTapOnBus:0];
  [_request endAudio];
  _request = nil;
  NSUInteger session = _session;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(GLWFinalResult * NSEC_PER_SEC)), self.methodQueue, ^{
    if (session == self->_session) {
      [self finish];
    }
  });
}

- (void)finish
{
  if ([self tearDown]) {
    [self sendEventWithName:@"dictationEnd" body:nil];
  }
}

- (BOOL)tearDown
{
  if (!_engine) {
    return NO;
  }
  [_engine stop];
  [_engine.inputNode removeTapOnBus:0];
  [_task cancel];
  _task = nil;
  _request = nil;
  _engine = nil;
  ++_session;
  ++_silence;
  [AVAudioSession.sharedInstance setActive:NO
                               withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                     error:nil];
  return YES;
}

- (void)invalidate
{
  [self tearDown];
  [super invalidate];
}

@end
