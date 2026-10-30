#import <AppKit/AppKit.h>
#import <libproc.h>
#include <stdlib.h>
#include <string.h>

static NSString *RNApplicationBundle(NSString *executable) {
    if (!executable.isAbsolutePath) return nil;
    NSString *path = @"/";
    // Use the enclosing application, including for nested helper app bundles.
    for (NSString *component in executable.stringByStandardizingPath.pathComponents) {
        path = [path stringByAppendingPathComponent:component];
        if ([component.pathExtension caseInsensitiveCompare:@"app"] == NSOrderedSame &&
            [NSBundle bundleWithPath:path] != nil) return path;
    }
    return nil;
}

static NSString *RNExecutableForPID(uint32_t pid, NSString *expected) {
    char buffer[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (pid == 0 || pid > INT_MAX ||
        proc_pidpath((int)pid, buffer, sizeof(buffer)) <= 0) return nil;
    NSString *path = [[NSFileManager defaultManager]
        stringWithFileSystemRepresentation:buffer length:strlen(buffer)];
    return [path.lastPathComponent isEqualToString:expected] ? path : nil;
}

char *rustnet_application_icon(const char *executable, const char *name,
                               const uint32_t *pids, size_t count) {
    @autoreleasepool {
        NSString *path = [NSString stringWithUTF8String:executable];
        NSString *bundle = RNApplicationBundle(path);
        // PKTAP can identify the process without providing an executable path.
        // Check its name before using a live PID, which may have been reused.
        if (path.length == 0) {
            NSString *expected = [NSString stringWithUTF8String:name];
            for (size_t i = 0; i < count && bundle == nil; i++) {
                bundle = RNApplicationBundle(RNExecutableForPID(pids[i], expected));
            }
        }
        if (bundle == nil) return NULL;
        NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:bundle];
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL pixelsWide:128 pixelsHigh:128 bitsPerSample:8
            samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace
            bytesPerRow:0 bitsPerPixel:0];
        NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
        if (context == nil) return NULL;
        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:context];
        [icon drawInRect:NSMakeRect(0, 0, 128, 128) fromRect:NSZeroRect
              operation:NSCompositingOperationCopy fraction:1.0 respectFlipped:NO hints:nil];
        [NSGraphicsContext restoreGraphicsState];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (png == nil) return NULL;
        NSString *url = [@"data:image/png;base64," stringByAppendingString:
            [png base64EncodedStringWithOptions:0]];
        return strdup(url.UTF8String);
    }
}

void rustnet_application_icon_free(char *icon) {
    free(icon);
}
