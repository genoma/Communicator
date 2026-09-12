// Communicator spelling helper: a long-lived Objective-C daemon that answers
// NSSpellChecker requests as newline-delimited JSON on stdin/stdout, replacing
// the per-call `osascript` spawn (~50-90 ms of CPU each).
//
// The program text in src/spelling/jxa.js is the parity contract and the
// semantics below are reproduced deliberately, not re-derived:
//   * `check` passes a NIL language (the user's whole active dictionary set)
//     and walks the remaining SUBSTRING from offset 0, rebasing the reported
//     range, because a follow-up checkSpellingOfString: with a non-zero
//     startingAt: answers NSNotFound;
//   * the word-scoped operations (`guesses`, `correction`, `completions`) pass
//     an EXPLICIT preferred language and the caller's word-aligned range: a nil
//     language or a misaligned range can hang completionsForPartialWordRange:
//     for seconds.
// stdout is the protocol channel — exactly one JSON line per request, always
// flushed, never anything else; diagnostics belong on stderr.
#import <AppKit/AppKit.h>
#include <stdio.h>
#include <stdlib.h>

static NSArray *spellingRanges(NSString *text) {
  NSSpellChecker *checker = NSSpellChecker.sharedSpellChecker;
  NSMutableArray *found = [NSMutableArray array];
  NSInteger base = 0;
  while ((NSUInteger)base < text.length) {
    NSString *rest = [text substringFromIndex:(NSUInteger)base];
    NSRange range = [checker checkSpellingOfString:rest
                                        startingAt:0
                                          language:nil
                                              wrap:NO
                            inSpellDocumentWithTag:0
                                         wordCount:NULL];
    if (range.location == NSNotFound || range.length == 0) break;
    [found addObject:@[@(base + (NSInteger)range.location), @((NSInteger)range.length)]];
    base += (NSInteger)range.location + (NSInteger)range.length;
  }
  return found;
}

static NSString *preferredLanguage(void) {
  NSString *language = NSLocale.preferredLanguages.firstObject;
  return language ?: NSSpellChecker.sharedSpellChecker.language;
}

static NSDictionary *respond(NSString *payload) {
  NSMutableDictionary *reply = [NSMutableDictionary dictionary];
  @try {
    id parsed = [NSJSONSerialization JSONObjectWithData:[payload dataUsingEncoding:NSUTF8StringEncoding]
                                                options:0
                                                  error:NULL];
    if (![parsed isKindOfClass:NSDictionary.class]) return @{@"error": @"unparsable request"};
    NSDictionary *request = parsed;
    if ([request[@"id"] isKindOfClass:NSNumber.class]) reply[@"id"] = request[@"id"];
    id op = request[@"op"];
    id text = request[@"text"];
    if (![op isKindOfClass:NSString.class] || ![text isKindOfClass:NSString.class]) {
      reply[@"error"] = @"missing op or text";
      return reply;
    }
    NSSpellChecker *checker = NSSpellChecker.sharedSpellChecker;
    if ([op isEqualToString:@"check"]) {
      reply[@"ranges"] = spellingRanges(text);
      return reply;
    }
    NSNumber *location = request[@"location"];
    NSNumber *length = request[@"length"];
    NSRange range = NSMakeRange(location ? location.integerValue : 0, length ? length.integerValue : 0);
    if ([op isEqualToString:@"guesses"]) {
      NSArray *words = [checker guessesForWordRange:range
                                           inString:text
                                           language:preferredLanguage()
                             inSpellDocumentWithTag:0];
      reply[@"words"] = words ?: @[];
    } else if ([op isEqualToString:@"completions"]) {
      NSArray *words = [checker completionsForPartialWordRange:range
                                                      inString:text
                                                      language:preferredLanguage()
                                        inSpellDocumentWithTag:0];
      reply[@"words"] = words ?: @[];
    } else if ([op isEqualToString:@"correction"]) {
      NSString *fixed = [checker correctionForWordRange:range
                                               inString:text
                                               language:preferredLanguage()
                                 inSpellDocumentWithTag:0];
      reply[@"correction"] = fixed ?: (id)NSNull.null;
    } else {
      reply[@"error"] = [@"unknown op: " stringByAppendingString:op];
    }
  } @catch (NSException *exception) {
    // An unexpected exception from the spelling service fails this one request
    // (with the id, so the caller is answered and the daemon and its restart
    // budget survive) instead of killing the child.
    reply[@"error"] = exception.reason ?: @"spelling service raised";
  }
  return reply;
}

int main(void) {
  @autoreleasepool {
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) != -1) {
      @autoreleasepool {
        NSString *payload = [[NSString alloc] initWithBytes:line
                                                     length:(NSUInteger)length
                                                   encoding:NSUTF8StringEncoding];
        NSDictionary *reply = payload ? respond(payload) : @{@"error": @"unreadable request"};
        NSData *data = [NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL];
        if (data != nil) {
          fwrite(data.bytes, 1, data.length, stdout);
          fputc('\n', stdout);
          fflush(stdout);
        }
      }
    }
    free(line);
  }
  return 0;
}
