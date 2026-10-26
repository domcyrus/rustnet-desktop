#import "Helper.h"
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static NSFileHandle *RNHandle(int fd) {
    return [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES];
}

static NSString *RNStageEngine(NSString *source, NSString **directory) {
    // Never check a signature and then exec a user-writable app path. Copy to
    // a private root directory first, validate that copy, and execute it there.
#ifdef RN_HELPER_TESTING
    NSString *template = [NSTemporaryDirectory() stringByAppendingPathComponent:@"rustnet-engine.XXXXXX"];
#else
    NSString *template = @"/private/var/run/rustnet-engine.XXXXXX";
#endif
    char *name = strdup(template.fileSystemRepresentation);
    if (!name) return nil;
    char *created = mkdtemp(name);
    if (!created) { free(name); return nil; }
    *directory = [NSString stringWithUTF8String:created];
    free(name);
    NSString *destination = [*directory stringByAppendingPathComponent:@"rustnet-capture-engine"];
    int input = open(source.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    int output = open(destination.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0500);
    struct stat info;
    BOOL valid = input >= 0 && output >= 0 && fstat(input, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_size > 0 && info.st_size <= 256LL * 1024 * 1024;
    char buffer[65536];
    ssize_t count = 0;
    size_t total = 0;
    while (valid) {
        do { count = read(input, buffer, sizeof(buffer)); } while (count < 0 && errno == EINTR);
        if (count <= 0) { valid = count == 0; break; }
        total += (size_t)count;
        if (total > 256UL * 1024 * 1024) { valid = NO; break; }
        for (ssize_t offset = 0; offset < count;) {
            ssize_t written = write(output, buffer + offset, (size_t)(count - offset));
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) { valid = NO; break; }
            offset += written;
        }
    }
    if (input >= 0) close(input);
    if (output >= 0) close(output);
#ifndef RN_HELPER_TESTING
    valid = valid && RNValidateCode(destination, RNRequirement(RNTeam(), RN_ENGINE_ID));
#endif
    if (!valid) {
        [[NSFileManager defaultManager] removeItemAtPath:*directory error:nil];
        *directory = nil;
        return nil;
    }
    return destination;
}

static BOOL RNValidFile(NSFileHandle *file, BOOL output, uid_t uid) {
    if (!file) return YES;
    struct stat info;
    int fd = file.fileDescriptor;
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) return NO;
    if (output) return (flags & O_ACCMODE) != O_RDONLY && info.st_uid == uid &&
        info.st_nlink == 1 && (info.st_mode & 077) == 0;
    return (flags & O_ACCMODE) != O_WRONLY && info.st_size <= 512LL * 1024 * 1024;
}

static NSArray<NSString *> *RNArguments(NSString *interface, NSArray *files) {
    NSMutableArray *arguments = [@[@"--headless", @"--output", @"jsonl",
        @"--headless-details", @"full", @"--capture-accounting", @"--stop-on-stdin-close",
        @"--include-historic", @"--refresh-interval", @"500", @"--sandbox-strict"] mutableCopy];
    if (interface.length) [arguments addObjectsFromArray:@[@"--interface", interface]];
    NSArray *flags = @[@"--pcapng-export", @"--geoip-country", @"--geoip-asn", @"--geoip-city"];
    for (NSUInteger i = 0; i < files.count; i++) {
        if ((id)files[i] != [NSNull null]) {
            [arguments addObjectsFromArray:@[flags[i], [NSString stringWithFormat:@"/dev/fd/%lu", 100UL + i]]];
        }
    }
    return arguments;
}

@interface RNSession : NSObject <RNCaptureService>
@property uid_t uid;
@property gid_t gid;
@property pid_t child;
@property BOOL disconnected;
@property(strong) NSFileHandle *controller;
@property(strong) NSFileHandle *exitWriter;
@property(copy) NSString *engine;
@property(strong) NSMutableSet<NSNumber *> *users;
- (void)stop;
@end

@implementation RNSession
- (void)stop {
    @synchronized (self) {
        self.disconnected = YES;
        [self.controller closeFile];
        self.controller = nil;
        pid_t pid = self.child;
        if (!pid) return;
        // The waiter leaves the child unreaped until it holds this same lock,
        // so the PID cannot be reused while this timeout checks and kills it.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC),
                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            @synchronized (self) {
                if (self.child == pid) kill(pid, SIGKILL);
            }
        });
    }
}

- (void)startCapture:(NSInteger)version interface:(NSString *)interface
          recording:(NSFileHandle *)recording country:(NSFileHandle *)country
                asn:(NSFileHandle *)asn city:(NSFileHandle *)city
              reply:(void (^)(NSFileHandle *, NSFileHandle *, NSFileHandle *, NSString *))reply {
    @synchronized (self) {
        if (self.disconnected || self.child || version != RN_PROTOCOL_VERSION ||
            ![interface isKindOfClass:[NSString class]] ||
            [interface lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 1024 ||
            [interface rangeOfString:[NSString stringWithFormat:@"%C", (unichar)0]].location != NSNotFound ||
            !RNValidFile(recording, YES, self.uid) || !RNValidFile(country, NO, self.uid) ||
            !RNValidFile(asn, NO, self.uid) || !RNValidFile(city, NO, self.uid)) {
            reply(nil, nil, nil, @"Invalid or incompatible capture request");
            return;
        }
        @synchronized (self.users) {
            if ([self.users containsObject:@(self.uid)]) {
                reply(nil, nil, nil, @"A privileged capture is already active for this user");
                return;
            }
            [self.users addObject:@(self.uid)];
        }
        NSArray *files = @[recording ?: (id)[NSNull null], country ?: (id)[NSNull null],
                           asn ?: (id)[NSNull null], city ?: (id)[NSNull null]];
        NSArray *arguments = RNArguments(interface, files);
        NSMutableArray<NSFileHandle *> *owned = [NSMutableArray array];
        int pipes[4][2];
        int status = 0;
        for (int i = 0; i < 4; i++) {
            if (pipe(pipes[i]) != 0) { status = errno; break; }
            [owned addObject:RNHandle(pipes[i][0])];
            [owned addObject:RNHandle(pipes[i][1])];
            fcntl(pipes[i][0], F_SETFD, FD_CLOEXEC);
            fcntl(pipes[i][1], F_SETFD, FD_CLOEXEC);
        }
        posix_spawn_file_actions_t actions;
        posix_spawnattr_t attributes;
        int actionsStatus = posix_spawn_file_actions_init(&actions);
        int attributesStatus = posix_spawnattr_init(&attributes);
        if (!status) status = actionsStatus ?: attributesStatus;
        if (!status) status = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT);
        if (!status) status = posix_spawn_file_actions_addchdir_np(&actions, "/var/empty");
        // Relocate sources above all destination descriptors before dup2 actions.
        NSMutableArray<NSFileHandle *> *sources = [NSMutableArray array];
        if (!status) {
            int input[] = {pipes[0][0], pipes[1][1], pipes[2][1]};
            for (int i = 0; i < 7; i++) {
                if (i >= 3 && files[i - 3] == [NSNull null]) continue;
                int original = i < 3 ? input[i] : [(NSFileHandle *)files[i - 3] fileDescriptor];
                int duplicate = fcntl(original, F_DUPFD_CLOEXEC, 200);
                if (duplicate < 0) { status = errno; break; }
                [sources addObject:RNHandle(duplicate)];
                status = posix_spawn_file_actions_adddup2(&actions, duplicate, i < 3 ? i : 100 + i - 3);
                if (status) break;
            }
        }
        NSString *staging = nil;
        NSString *executable = nil;
        if (!status) {
            executable = RNStageEngine(self.engine, &staging);
            if (!executable) status = EPERM;
        }
        NSMutableArray<NSString *> *argv = [NSMutableArray arrayWithObject:executable ?: self.engine];
        [argv addObjectsFromArray:arguments];
        char **cargv = calloc(argv.count + 1, sizeof(char *));
        if (!cargv) status = ENOMEM;
        else for (NSUInteger i = 0; i < argv.count; i++) cargv[i] = (char *)argv[i].UTF8String;
        // Identity comes from the authenticated XPC peer, never request data.
        NSArray<NSString *> *environment = @[@"PATH=/usr/bin:/bin:/usr/sbin:/sbin", @"HOME=/var/empty",
            @"XDG_DATA_HOME=/var/empty", @"LANG=en_US.UTF-8",
            [NSString stringWithFormat:@"SUDO_UID=%u", self.uid],
            [NSString stringWithFormat:@"SUDO_GID=%u", self.gid]];
        char *envp[7] = {0};
        for (NSUInteger i = 0; i < environment.count; i++) envp[i] = (char *)environment[i].UTF8String;
        pid_t pid = 0;
        if (!status) status = posix_spawn(&pid, executable.fileSystemRepresentation, &actions, &attributes, cargv, envp);
        free(cargv);
        if (!actionsStatus) posix_spawn_file_actions_destroy(&actions);
        if (!attributesStatus) posix_spawnattr_destroy(&attributes);
        for (NSFileHandle *source in sources) [source closeFile];
        if (status) {
            if (staging) [[NSFileManager defaultManager] removeItemAtPath:staging error:nil];
            for (NSFileHandle *file in owned) [file closeFile];
            @synchronized (self.users) { [self.users removeObject:@(self.uid)]; }
            reply(nil, nil, nil, [NSString stringWithFormat:@"Cannot launch the signed capture engine: %s", strerror(status)]);
            return;
        }
        self.child = pid;
        self.controller = owned[1];
        self.exitWriter = owned[7];
        [owned[0] closeFile];
        [owned[3] closeFile];
        [owned[5] closeFile];
        reply(owned[2], owned[4], owned[6], nil);
        // XPC owns the transferred read ends after serializing the reply.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            siginfo_t information = {0};
            int waited;
            do { waited = waitid(P_PID, (id_t)pid, &information, WEXITED | WNOWAIT); }
            while (waited < 0 && errno == EINTR);
            @synchronized (self) {
                int exitStatus = 0;
                pid_t reaped;
                do { reaped = waitpid(pid, &exitStatus, 0); } while (reaped < 0 && errno == EINTR);
                self.child = 0;
                int code = reaped < 0 ? 255 : WIFEXITED(exitStatus) ? WEXITSTATUS(exitStatus) : 128 + WTERMSIG(exitStatus);
                NSString *result = [NSString stringWithFormat:@"%d\n", code];
                [self.controller closeFile];
                self.controller = nil;
                @synchronized (self.users) { [self.users removeObject:@(self.uid)]; }
                [[NSFileManager defaultManager] removeItemAtPath:staging error:nil];
                // A disconnected client may already have closed its status pipe.
                // Publish exit only after the capture slot and staged copy are released.
                write(self.exitWriter.fileDescriptor, result.UTF8String, strlen(result.UTF8String));
                [self.exitWriter closeFile];
                self.exitWriter = nil;
            }
        });
    }
}
@end

@interface RNListener : NSObject <NSXPCListenerDelegate>
@property(copy) NSString *engine;
@property(strong) NSMutableSet<NSNumber *> *users;
@end
@implementation RNListener
- (BOOL)listener:(NSXPCListener *)listener shouldAcceptNewConnection:(NSXPCConnection *)connection {
    (void)listener;
    if (!connection.effectiveUserIdentifier || !connection.effectiveGroupIdentifier) return NO;
    [connection setCodeSigningRequirement:RNRequirement(RNTeam(), RN_APP_ID)];
    RNSession *session = [RNSession new];
    session.uid = connection.effectiveUserIdentifier;
    session.gid = connection.effectiveGroupIdentifier;
    session.engine = self.engine;
    session.users = self.users;
    connection.exportedInterface = [NSXPCInterface interfaceWithProtocol:@protocol(RNCaptureService)];
    connection.exportedObject = session;
    connection.invalidationHandler = ^{ [session stop]; };
    connection.interruptionHandler = ^{ [session stop]; };
    [connection resume];
    return YES;
}
@end

#ifndef RN_HELPER_TESTING
int main(void) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        NSString *team = RNTeam();
        if (geteuid() != 0 || !team) return EXIT_FAILURE;
        char executable[PATH_MAX];
        uint32_t length = sizeof(executable);
        if (_NSGetExecutablePath(executable, &length) != 0) return EXIT_FAILURE;
        NSString *path = [[NSString stringWithUTF8String:executable] stringByResolvingSymlinksInPath];
        __attribute__((objc_precise_lifetime)) RNListener *delegate = [RNListener new];
        delegate.engine = [[path stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"rustnet-capture-engine"];
        delegate.users = [NSMutableSet set];
        __attribute__((objc_precise_lifetime)) NSXPCListener *listener = [[NSXPCListener alloc] initWithMachServiceName:RN_SERVICE];
        [listener setConnectionCodeSigningRequirement:RNRequirement(team, RN_APP_ID)];
        listener.delegate = delegate;
        [listener resume];
        [[NSRunLoop currentRunLoop] run];
    }
    return EXIT_SUCCESS;
}
#endif
