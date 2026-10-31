#import "application-icons.m"
#include <unistd.h>

static void RNCheck(BOOL condition, NSString *message) {
    if (!condition) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}

static NSBitmapImageRep *RNDecodeIcon(char *url) {
    if (url == NULL) return nil;
    NSString *text = [NSString stringWithUTF8String:url];
    rustnet_application_icon_free(url);
    NSString *prefix = @"data:image/png;base64,";
    if (![text hasPrefix:prefix]) return nil;
    NSData *data = [[NSData alloc] initWithBase64EncodedString:
        [text substringFromIndex:prefix.length] options:0];
    return [NSBitmapImageRep imageRepWithData:data];
}

int main(void) {
    @autoreleasepool {
        // A metadata-only fixture covers unusual paths without launching an app.
        NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        NSString *bundle = [directory stringByAppendingPathComponent:@"Icon path 日本語.app"];
        NSString *contents = [bundle stringByAppendingPathComponent:@"Contents"];
        NSFileManager *files = [NSFileManager defaultManager];
        RNCheck([files createDirectoryAtPath:contents withIntermediateDirectories:YES attributes:nil error:nil], @"Create metadata fixture");
        NSDictionary *info = @{@"CFBundleIdentifier": @"org.example.icon-path-test",
                               @"CFBundleName": @"Icon path", @"CFBundlePackageType": @"APPL"};
        RNCheck([info writeToURL:[NSURL fileURLWithPath:[contents stringByAppendingPathComponent:@"Info.plist"]] error:nil], @"Write bundle metadata");
        RNCheck([RNApplicationBundle([contents stringByAppendingPathComponent:@"MacOS/test"]) isEqualToString:bundle], @"Resolve bundle with spaces and Unicode");
        RNCheck([RNApplicationBundle([contents stringByAppendingPathComponent:@"Frameworks/Helper.app/Contents/MacOS/helper"]) isEqualToString:bundle], @"Nested helpers use the outer application");
        RNCheck([files removeItemAtPath:directory error:nil], @"Remove metadata fixture");

        RNCheck(RNApplicationBundle(@"relative.app/Contents/MacOS/test") == nil, @"Reject relative paths");
        RNCheck(rustnet_application_icon("/usr/bin/false", "false", NULL, 0) == NULL, @"CLI processes retain the placeholder");
        RNCheck(rustnet_application_icon("/missing.app/Contents/MacOS/test", "test", NULL, 0) == NULL, @"Missing bundles retain the placeholder");
        NSBitmapImageRep *image = RNDecodeIcon(rustnet_application_icon(
            "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "Terminal", NULL, 0));
        RNCheck(image.pixelsWide == 128 && image.pixelsHigh == 128, @"Return a bounded PNG of an installed system app");
        BOOL visible = NO;
        for (NSInteger y = 0; y < 128 && !visible; y++) {
            for (NSInteger x = 0; x < 128 && !visible; x++) {
                NSColor *pixel = [[image colorAtX:x y:y] colorUsingColorSpace:[NSColorSpace deviceRGBColorSpace]];
                visible = pixel.alphaComponent > 0.9 &&
                    pixel.redComponent + pixel.greenComponent + pixel.blueComponent > 0.3;
            }
        }
        RNCheck(visible, @"Icon contains visible pixels; macOS icon services must be accessible");

        NSString *name = NSProcessInfo.processInfo.arguments.firstObject.lastPathComponent;
        uint32_t pid = (uint32_t)getpid();
        RNCheck([RNExecutableForPID(pid, name).lastPathComponent isEqualToString:name], @"Resolve the current process without launching a fixture");
        RNCheck(RNExecutableForPID(pid, @"different-process") == nil, @"Reject a PID whose process name does not match");
        RNCheck(RNExecutableForPID(0, name) == nil && RNExecutableForPID(UINT32_MAX, name) == nil, @"Reject invalid PIDs");
        RNCheck(rustnet_application_icon("", name.UTF8String, &pid, 1) == NULL, @"A live CLI process retains the placeholder");
        puts("macOS application icon tests passed");
    }
}
