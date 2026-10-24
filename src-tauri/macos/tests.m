// The test build runs the broker as the current user with a fixture engine.
// Production builds always enforce the engine's Developer ID requirement.
#define RN_HELPER_TESTING 1
#import "daemon.m"

static void RNCheck(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}

int main(void) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        RNCheck([[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:NO attributes:nil error:nil], @"Create fixture directory");
        NSString *engine = [directory stringByAppendingPathComponent:@"fixture"];
        NSString *script = @"#!/bin/sh\nprintf 'running\\n'\nprintf recorded > /dev/fd/100\ncat >/dev/null\nprintf 'stopped\\n'\n";
        RNCheck([script writeToFile:engine atomically:YES encoding:NSUTF8StringEncoding error:nil], @"Create fixture engine");
        chmod(engine.fileSystemRepresentation, 0700);
        NSString *staging = nil;
        NSString *copy = RNStageEngine(engine, &staging);
        RNCheck(copy != nil, @"Stage executable in a private directory");
        [@"replaced" writeToFile:engine atomically:YES encoding:NSUTF8StringEncoding error:nil];
        RNCheck([[NSString stringWithContentsOfFile:copy encoding:NSUTF8StringEncoding error:nil] isEqualToString:script], @"Source replacement cannot change the protected executable");
        [[NSFileManager defaultManager] removeItemAtPath:staging error:nil];
        [script writeToFile:engine atomically:YES encoding:NSUTF8StringEncoding error:nil];
        chmod(engine.fileSystemRepresentation, 0700);
        NSString *alias = [directory stringByAppendingPathComponent:@"alias"];
        symlink(engine.fileSystemRepresentation, alias.fileSystemRepresentation);
        RNCheck(RNStageEngine(alias, &staging) == nil, @"Reject symlinked engine sources");
        NSString *recording = [directory stringByAppendingPathComponent:@"capture"];
        int fd = open(recording.fileSystemRepresentation, O_CREAT | O_EXCL | O_WRONLY, 0600);
        RNCheck(fd >= 0, @"Open recording as the current user");
        NSFileHandle *file = RNHandle(fd);
        RNCheck(RNValidFile(file, YES, getuid()), @"Accept private recording descriptor");
        RNCheck(!RNValidFile(file, YES, getuid() + 1), @"Reject another user's recording");
        chmod(recording.fileSystemRepresentation, 0666);
        RNCheck(!RNValidFile(file, YES, getuid()), @"Reject shared recording");
        chmod(recording.fileSystemRepresentation, 0600);
        int descriptorDirectory = open("/dev/fd", O_SEARCH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int reopened = openat(descriptorDirectory, [[NSString stringWithFormat:@"%d", fd] UTF8String],
                             O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
        RNCheck(reopened >= 0, @"Engine's secure opener can reopen the handed-off descriptor");
        close(reopened); close(descriptorDirectory);
        NSArray *arguments = RNArguments(@"en0; touch /tmp/never", @[file, [NSNull null], [NSNull null], [NSNull null]]);
        RNCheck([arguments containsObject:@"en0; touch /tmp/never"] && [arguments containsObject:@"/dev/fd/100"] &&
                [arguments containsObject:@"--sandbox-strict"] && ![arguments containsObject:@"--no-uid-drop"], @"Typed arguments and descriptor paths");
        RNCheck(!RNValidateCode(@"/bin/sh", RNRequirement(@"INVALID123", RN_ENGINE_ID)), @"Reject foreign engine signatures");
        RNCheck(RNRequirement(nil, RN_APP_ID) == nil, @"No ad-hoc trust fallback");

        RNSession *session = [RNSession new];
        session.engine = engine; session.uid = getuid(); session.gid = getgid(); session.users = [NSMutableSet set];
        __block NSArray<NSFileHandle *> *streams;
        [session startCapture:99 interface:@"" recording:file country:nil asn:nil city:nil
                       reply:^(NSFileHandle *out, NSFileHandle *err, NSFileHandle *status, NSString *error) {
            (void)out; (void)err; (void)status;
            RNCheck(error != nil && session.child == 0, @"Reject incompatible protocols before launch");
        }];
        [session startCapture:RN_PROTOCOL_VERSION interface:@"" recording:file country:nil asn:nil city:nil
                       reply:^(NSFileHandle *out, NSFileHandle *err, NSFileHandle *status, NSString *error) {
            RNCheck(error == nil && out && err && status, error ?: @"Return capture pipes");
            streams = @[out, err, status];
        }];
        RNSession *second = [RNSession new];
        second.engine = engine; second.uid = getuid(); second.gid = getgid(); second.users = session.users;
        [second startCapture:RN_PROTOCOL_VERSION interface:@"" recording:nil country:nil asn:nil city:nil
                      reply:^(NSFileHandle *out, NSFileHandle *err, NSFileHandle *status, NSString *error) {
            (void)out; (void)err; (void)status;
            RNCheck(error != nil && second.child == 0, @"Reject concurrent captures for the same user");
        }];
        [session stop];
        NSString *output = [[NSString alloc] initWithData:[streams[0] readDataToEndOfFile] encoding:NSUTF8StringEncoding];
        NSString *status = [[NSString alloc] initWithData:[streams[2] readDataToEndOfFile] encoding:NSUTF8StringEncoding];
        RNCheck([output isEqualToString:@"running\nstopped\n"] && [status isEqualToString:@"0\n"], @"Disconnect closes stdin and flushes output");
        RNCheck([[NSString stringWithContentsOfFile:recording encoding:NSUTF8StringEncoding error:nil] isEqualToString:@"recorded"], @"Inherited recording descriptor is writable");
        RNCheck(![session.users containsObject:@(getuid())], @"Release the per-user capture slot");
        [file closeFile];
        for (NSFileHandle *stream in streams) [stream closeFile];
        [[NSFileManager defaultManager] removeItemAtPath:directory error:nil];
        puts("macOS helper broker tests passed");
    }
    return 0;
}
