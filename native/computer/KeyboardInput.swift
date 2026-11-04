import Foundation
import ApplicationServices

func unicodeKeyEvents(_ text: String) throws -> (CGEvent, CGEvent) {
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        throw failure("NATIVE_ERROR", "Cannot create Unicode key events.")
    }
    for event in [down, up] {
        // Unicode content is independent of modifiers held by the user.
        event.flags = []
        units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
        var count = 0
        var recovered = [UniChar](repeating: 0, count: units.count)
        recovered.withUnsafeMutableBufferPointer {
            event.keyboardGetUnicodeString(maxStringLength: units.count, actualStringLength: &count, unicodeString: $0.baseAddress)
        }
        guard count == units.count, recovered == units else { throw failure("UNSUPPORTED", "macOS could not encode the complete Unicode key event.") }
    }
    return (down, up)
}

@MainActor func sendUnicodeText(_ text: String, checkFocus: () throws -> Void,
                                 post: (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) }) async throws {
    var dispatched = 0
    do {
        for character in text {
            let value = String(character)
            let (down, up) = try unicodeKeyEvents(value)
            try checkFocus()
            // No suspension or fallible work between the paired events.
            post(down); post(up)
            dispatched += value.utf16.count
            await Task.yield()
        }
    } catch let error as BridgeFailure {
        throw failure(error.code, "Unicode input stopped after dispatching \(dispatched) UTF-16 units (not readback verification). \(error.message)", dispatched > 0 ? "unknown" : error.delivery)
    }
}

@MainActor func testKeyboardInput() async throws {
    let samples = ["中文 English 😀 e\u{301}\nSecond line", String(repeating: "👨‍👩‍👧‍👦", count: 200), "x" + String(repeating: "\u{301}", count: 100)]
    for text in samples {
        var actual: [UniChar] = []
        var events: [CGEventType] = []
        try await sendUnicodeText(text, checkFocus: {}, post: { event in
            precondition(event.flags.isEmpty)
            events.append(event.type)
            if event.type == .keyDown {
                var count = 0
                event.keyboardGetUnicodeString(maxStringLength: 0, actualStringLength: &count, unicodeString: nil)
                var units = [UniChar](repeating: 0, count: count)
                let capacity = count
                units.withUnsafeMutableBufferPointer { event.keyboardGetUnicodeString(maxStringLength: capacity, actualStringLength: &count, unicodeString: $0.baseAddress) }
                actual += units
            }
        })
        precondition(actual == Array(text.utf16))
        precondition(events == text.flatMap { _ in [CGEventType.keyDown, .keyUp] })
    }
    for failAt in [0, 2] {
        var checks = 0
        var posted = 0
        do {
            try await sendUnicodeText("甲😀乙丙", checkFocus: {
                defer { checks += 1 }
                if checks == failAt { throw failure("TARGET_CHANGED", "Injected focus change.") }
            }, post: { _ in posted += 1 })
            preconditionFailure("Focus change must stop input")
        } catch let error as BridgeFailure {
            precondition(error.code == "TARGET_CHANGED")
            precondition(posted == failAt * 2)
            precondition(error.delivery == (failAt == 0 ? "not_delivered" : "unknown"))
            precondition(error.message.contains("dispatching \(failAt == 0 ? 0 : 3) UTF-16 units"))
        }
    }
}
