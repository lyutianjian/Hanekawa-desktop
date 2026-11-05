import Foundation
import ApplicationServices

@MainActor func sendMouseClicks(point: CGPoint, button: CGMouseButton, count: Int,
                               checkTarget: () throws -> Void,
                               post: (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) }) throws {
    guard (1...3).contains(count) else { throw failure("INVALID_INPUT", "Invalid click count.") }
    let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    var dispatched = 0
    do {
        for i in 1...count {
            guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
                  let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else {
                throw failure("NATIVE_ERROR", "Cannot create mouse events.")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            try checkTarget()
            // No suspension, revalidation or fallible operation between events.
            post(down); post(up)
            dispatched += 1
        }
    } catch let error as BridgeFailure {
        throw failure(error.code, "Mouse input stopped after dispatching \(dispatched) click pairs (not readback verification). \(error.message)", dispatched > 0 ? "unknown" : error.delivery)
    }
}

@MainActor func testMouseInput() throws -> Int {
    let point = CGPoint(x: 17, y: 23)
    for failAt in [0, 1, 2] {
        var checks = 0
        var events: [CGEventType] = []
        do {
            try sendMouseClicks(point: point, button: .left, count: 3, checkTarget: {
                precondition(events.count == checks * 2)
                defer { checks += 1 }
                if checks == failAt { throw failure("TARGET_CHANGED", "Injected exact identity failure.") }
            }, post: { event in
                precondition(event.getIntegerValueField(.mouseEventClickState) == Int64(events.count / 2 + 1))
                events.append(event.type)
            })
            preconditionFailure("Identity failure must stop the production click loop")
        } catch let error as BridgeFailure {
            precondition(error.code == "TARGET_CHANGED")
            precondition(error.delivery == (failAt == 0 ? "not_delivered" : "unknown"))
            precondition(error.message.contains("dispatching \(failAt) click pairs"))
            precondition(checks == failAt + 1)
            precondition(events == (0..<failAt).flatMap { _ in [CGEventType.leftMouseDown, .leftMouseUp] })
        }
    }
    for button in [CGMouseButton.left, .right] {
        var checks = 0
        var events: [CGEventType] = []
        try sendMouseClicks(point: point, button: button, count: 3, checkTarget: {
            precondition(events.count == checks * 2)
            checks += 1
        }, post: { event in
            precondition(event.location == point)
            precondition(event.getIntegerValueField(.mouseEventClickState) == Int64(events.count / 2 + 1))
            events.append(event.type)
        })
        precondition(checks == 3)
        let pair: [CGEventType] = button == .left ? [.leftMouseDown, .leftMouseUp] : [.rightMouseDown, .rightMouseUp]
        precondition(events == (0..<3).flatMap { _ in pair })
    }
    return 5
}
