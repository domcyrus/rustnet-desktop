#import <Foundation/Foundation.h>
#import <Security/Security.h>

#define RN_SERVICE @"io.github.domcyrus.rustnet.desktop.capture"
#define RN_PLIST @"io.github.domcyrus.rustnet.desktop.capture.plist"
#define RN_APP_ID @"io.github.domcyrus.rustnet.desktop"
#define RN_HELPER_ID @"io.github.domcyrus.rustnet.desktop.capture-helper"
#define RN_ENGINE_ID @"rustnet-capture-engine"
#define RN_PROTOCOL_VERSION 1

// Paths and executable arguments never cross the privileged interface. Files
// must already be open in the unprivileged app before they are sent over XPC.
@protocol RNCaptureService
- (void)startCapture:(NSInteger)version
          interface:(NSString *)interface
          recording:(NSFileHandle *)recording
            country:(NSFileHandle *)country
                asn:(NSFileHandle *)asn
               city:(NSFileHandle *)city
              reply:(void (^)(NSFileHandle *, NSFileHandle *, NSFileHandle *, NSString *))reply;
@end

static NSString *RNTeam(void) {
    SecCodeRef code = NULL;
    CFDictionaryRef information = NULL;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess) return nil;
    OSStatus status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information);
    CFRelease(code);
    if (status != errSecSuccess) return nil;
    NSDictionary *details = CFBridgingRelease(information);
    NSString *team = details[(__bridge NSString *)kSecCodeInfoTeamIdentifier];
    if (team.length != 10 || [team rangeOfCharacterFromSet:
            [[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] invertedSet]].location != NSNotFound) return nil;
    return team;
}

static NSString *RNRequirement(NSString *team, NSString *identifier) {
    if (!team) return nil;
    return [NSString stringWithFormat:
        @"anchor apple generic and certificate leaf[subject.OU] = \"%@\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier \"%@\"",
        team, identifier];
}

static inline BOOL RNValidateCode(NSString *path, NSString *requirement) {
    if (!requirement) return NO;
    SecStaticCodeRef code = NULL;
    SecRequirementRef rule = NULL;
    OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:path],
                                                 kSecCSDefaultFlags, &code);
    if (status == errSecSuccess) status = SecRequirementCreateWithString((__bridge CFStringRef)requirement,
                                                                       kSecCSDefaultFlags, &rule);
    if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures, rule);
    if (rule) CFRelease(rule);
    if (code) CFRelease(code);
    return status == errSecSuccess;
}
