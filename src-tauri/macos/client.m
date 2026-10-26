#import "Helper.h"
#import <ServiceManagement/ServiceManagement.h>
#include <fcntl.h>
#include <unistd.h>

// All exported C entry points return owned strings or descriptors. Rust frees
// strings with rustnet_helper_free and invalidates retained XPC connections.
static char *RNJSON(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
}

static NSDictionary *RNState(void) {
    NSBundle *bundle = NSBundle.mainBundle;
    if (![bundle.bundleIdentifier isEqualToString:RN_APP_ID] || !RNTeam()) {
        return @{@"status": @"unavailable", @"can_register": @NO,
            @"message": @"PKTAP helper requires a Developer ID signed, notarized app in Applications. Development and ad-hoc builds use ordinary BPF capture."};
    }
    SMAppService *service = [SMAppService daemonServiceWithPlistName:RN_PLIST];
    NSArray *statuses = @[@"not_registered", @"enabled", @"requires_approval", @"not_found"];
    NSUInteger status = service.status;
    return @{@"status": status < statuses.count ? statuses[status] : @"unavailable",
             @"can_register": @(status != SMAppServiceStatusNotFound),
             @"message": status == SMAppServiceStatusRequiresApproval
                 ? @"Approve RustNet Desktop in System Settings > General > Login Items & Extensions, then recheck status."
                 : status == SMAppServiceStatusEnabled ? @"Capture helper is enabled. Automatic uses PKTAP; explicit interfaces use ordinary capture."
                 : @"Enable the capture helper for PKTAP process attribution. Without it, capture needs BPF access and uses the lsof fallback."};
}

char *rustnet_helper_manage(const char *action) {
    @autoreleasepool {
        NSDictionary *state = RNState();
        NSString *operation = [NSString stringWithUTF8String:action];
        if ([operation isEqualToString:@"status"]) return RNJSON(state);
        if (![state[@"can_register"] boolValue]) return RNJSON(@{@"error": state[@"message"]});
        NSError *error = nil;
        SMAppService *service = [SMAppService daemonServiceWithPlistName:RN_PLIST];
        if ([operation isEqualToString:@"register"]) {
            if (service.status == SMAppServiceStatusNotRegistered) [service registerAndReturnError:&error];
        } else if ([operation isEqualToString:@"unregister"]) {
            if (service.status != SMAppServiceStatusNotRegistered) [service unregisterAndReturnError:&error];
        } else if ([operation isEqualToString:@"settings"]) {
            [SMAppService openSystemSettingsLoginItems];
        } else {
            return RNJSON(@{@"error": @"Unknown helper operation"});
        }
        if (error && !([operation isEqualToString:@"register"] &&
                       service.status == SMAppServiceStatusRequiresApproval))
            return RNJSON(@{@"error": error.localizedDescription});
        return RNJSON(RNState());
    }
}

void rustnet_helper_free(char *text) { free(text); }

// fileDescriptors: recording, country, ASN, city. Negative means absent.
// resultDescriptors: snapshots, diagnostics, exit status. Owned by the caller.
void *rustnet_helper_start(const char *interface, const int *fileDescriptors,
                          int *resultDescriptors, char **error) {
    @autoreleasepool {
        NSString *requirement = RNRequirement(RNTeam(), RN_HELPER_ID);
        if (!requirement) { *error = strdup("A Developer ID signed app is required"); return NULL; }
        NSXPCConnection *connection = [[NSXPCConnection alloc] initWithMachServiceName:RN_SERVICE options:NSXPCConnectionPrivileged];
        [connection setCodeSigningRequirement:requirement];
        connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(RNCaptureService)];
        [connection resume];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        // Reply state is heap-owned by blocks even if the request times out.
        __block NSArray<NSFileHandle *> *received = nil;
        __block NSString *failure = nil;
        id<RNCaptureService> remote = [connection remoteObjectProxyWithErrorHandler:^(NSError *reason) {
            failure = reason.localizedDescription;
            dispatch_semaphore_signal(done);
        }];
        NSFileHandle *files[4] = {nil};
        for (int i = 0; i < 4; i++) if (fileDescriptors[i] >= 0)
            files[i] = [[NSFileHandle alloc] initWithFileDescriptor:fileDescriptors[i] closeOnDealloc:NO];
        [remote startCapture:RN_PROTOCOL_VERSION interface:[NSString stringWithUTF8String:interface]
                   recording:files[0] country:files[1] asn:files[2] city:files[3]
                       reply:^(NSFileHandle *output, NSFileHandle *diagnostics, NSFileHandle *status, NSString *message) {
            failure = message;
            if (output && diagnostics && status) received = @[output, diagnostics, status];
            dispatch_semaphore_signal(done);
        }];
        BOOL timedOut = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0;
        if (timedOut || failure || received.count != 3) {
            [connection invalidate];
            *error = strdup((timedOut ? @"Capture helper timed out. Recheck its approval in System Settings." :
                failure ?: @"Capture helper returned an invalid response").UTF8String);
            return NULL;
        }
        for (int i = 0; i < 3; i++) {
            resultDescriptors[i] = fcntl(received[i].fileDescriptor, F_DUPFD_CLOEXEC, 3);
            if (resultDescriptors[i] < 0) {
                for (int j = 0; j < i; j++) close(resultDescriptors[j]);
                [connection invalidate];
                *error = strdup("Cannot retain helper output descriptors");
                return NULL;
            }
        }
        return (__bridge_retained void *)connection;
    }
}

void rustnet_helper_disconnect(void *session) {
    @autoreleasepool {
        NSXPCConnection *connection = CFBridgingRelease(session);
        [connection invalidate];
    }
}
