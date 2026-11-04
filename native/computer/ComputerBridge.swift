// Hanekawa's public-API macOS driver. Private child stdio; no network service,
// arbitrary scripts, Codex binaries or proprietary implementation code.
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

let protocolVersion = "hanekawa-computer/4"
struct BridgeFailure: Error {
    let code: String
    let message: String
    var delivery = "not_delivered"
}
func failure(_ code: String, _ message: String, _ delivery: String = "not_delivered") -> BridgeFailure {
    BridgeFailure(code: code, message: message, delivery: delivery)
}
func integer(_ value: Any?) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
          n.doubleValue >= 0, n.doubleValue < Double(Int.max), n.doubleValue.rounded() == n.doubleValue else { return nil }
    return n.intValue
}
func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
    return n.doubleValue
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func boundedText(_ text: String, limit: Int) -> String {
    var result = ""
    var length = 0
    for character in text {
        let count = String(character).utf16.count
        if count > limit - length { break }
        result.append(character)
        length += count
    }
    return result
}
func attributeText(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attribute(element, name) else { return "" }
    guard CFGetTypeID(value) == CFStringGetTypeID() || CFGetTypeID(value) == CFNumberGetTypeID() else { return "" }
    return String(describing: value)
}
func stringAttribute(_ element: AXUIElement, _ name: String, limit: Int = 200) -> String {
    // Keep the UTF-16 length within the TS protocol's string budget too.
    return boundedText(attributeText(element, name), limit: limit)
}
func rect(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size),
          point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
}
func jsonRect(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
}
func secure(_ element: AXUIElement) -> Bool { stringAttribute(element, kAXSubroleAttribute) == "AXSecureTextField" }
func fingerprint(_ element: AXUIElement) -> [String] {
    if secure(element) { return [stringAttribute(element, kAXRoleAttribute), "AXSecureTextField"] }
    // Private comparison only: a change beyond the displayed prefix also invalidates identity/ref.
    return [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, kAXValueAttribute].map { attributeText(element, $0) }
}
func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return Array((names as? [String] ?? []).prefix(32)).map { boundedText($0, limit: 50) }
}
func requireAX() throws {
    guard AXIsProcessTrusted() else { throw failure("PERMISSION_REQUIRED", "Grant Accessibility to Hanekawa (or Electron/its launching terminal during development) in System Settings > Privacy & Security > Accessibility.") }
}

@MainActor final class AppSession {
    var pinnedApp: NSRunningApplication?
    var launchDate: Date?
    var windows: [(String, AXUIElement)] = []
    var nextWindow = 1
    var revision = 0
    var elements: [AXUIElement] = []
    var fingerprints: [[String]] = []
    var elementWindows: [AXUIElement?] = []
    var elementBounds: [CGRect?] = []
    var observedScope: String?
    var observedWindow: AXUIElement?
    var observedBounds: CGRect?
    var observedWindowID: String?
    let identities = ElementIdentityRegistry()

    func invalidate() { elements.removeAll(); fingerprints.removeAll(); elementWindows.removeAll(); elementBounds.removeAll(); observedScope = nil; observedWindow = nil; observedBounds = nil; observedWindowID = nil }
    func app() throws -> NSRunningApplication {
        guard let app = pinnedApp else { throw failure("TARGET_CHANGED", "No target process is bound.") }
        guard !app.isTerminated else { invalidate(); throw failure("TARGET_CHANGED", "The pinned target process terminated. Bind it again.") }
        guard let live = NSRunningApplication(processIdentifier: app.processIdentifier) else { invalidate(); throw failure("TARGET_CHANGED", "The target process is no longer registered. Bind it again.") }
        guard live.bundleIdentifier == app.bundleIdentifier else { invalidate(); throw failure("TARGET_CHANGED", "The target bundle identity changed. Bind it again.") }
        guard live.launchDate == launchDate else {
            invalidate()
            throw failure("TARGET_CHANGED", "Target launch identity changed. Bind it again.")
        }
        return live
    }
    func bind(_ target: String) throws -> [String: Any] {
        guard pinnedApp == nil, !target.isEmpty, target.utf16.count <= 1024 else { throw failure("INVALID_INPUT", "Invalid app binding.") }
        let matches = NSWorkspace.shared.runningApplications.filter { app in
            guard !app.isTerminated, app.bundleIdentifier != nil else { return false }
            return app.bundleIdentifier == target || app.bundleURL?.standardizedFileURL.path == target || app.localizedName?.caseInsensitiveCompare(target) == .orderedSame
        }
        guard matches.count == 1, let selected = matches.first else { throw failure("TARGET_CHANGED", "App must already be running and uniquely identified. Use list_apps and its bundleId.") }
        pinnedApp = selected; launchDate = selected.launchDate
        let rows = try listWindows()
        return ["protocol": protocolVersion, "bundleId": selected.bundleIdentifier!, "name": boundedText(selected.localizedName ?? "", limit: 200), "processId": selected.processIdentifier, "windows": rows]
    }
    func listWindows() throws -> [[String: Any]] {
        try requireAX()
        let pid = try app().processIdentifier
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 0.5)
        guard let live = attribute(root, kAXWindowsAttribute) as? [AXUIElement] else { throw failure("NATIVE_ERROR", "Application did not expose its AX windows.") }
        guard live.count <= 100 else { throw failure("UNSUPPORTED", "Too many application windows.") }
        var current: [(String, AXUIElement)] = []
        for element in live {
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == pid else { continue }
            AXUIElementSetMessagingTimeout(element, 0.5)
            guard rect(element) != nil else { continue }
            if let previous = windows.first(where: { CFEqual($0.1, element) }) { current.append(previous) }
            else { current.append(("w\(nextWindow)", element)); nextWindow += 1 }
        }
        windows = current
        return current.compactMap { id, element -> [String: Any]? in
            guard let bounds = rect(element) else { return nil }
            return ["id": id, "title": stringAttribute(element, kAXTitleAttribute), "role": stringAttribute(element, kAXRoleAttribute, limit: 100), "bounds": jsonRect(bounds)]
        }
    }
    func window(_ id: String) throws -> AXUIElement {
        _ = try listWindows()
        guard let selected = windows.first(where: { $0.0 == id })?.1 else { throw failure("TARGET_CHANGED", "Selected window closed. Read get_state and choose a current window.") }
        return selected
    }
    func checkedSnapshot(_ input: [String: Any]) throws -> (AXUIElement?, CGRect?, AXUIElement?) {
        try requireAX()
        _ = try app()
        guard integer(input["revision"]) == revision, let scope = observedScope else { throw failure("STALE_SNAPSHOT", "Read fresh state before acting.") }
        var current: AXUIElement?
        var bounds: CGRect?
        if scope == "window" {
            guard let old = observedWindow, let priorBounds = observedBounds, let id = observedWindowID else { throw failure("STALE_SNAPSHOT", "Read a window snapshot before acting.") }
            let live = try window(id)
            guard CFEqual(live, old), let liveBounds = rect(live), sameRect(priorBounds, liveBounds) else { throw failure("TARGET_CHANGED", "Window moved, resized or changed. Observe again.") }
            current = live; bounds = liveBounds
        }
        var element: AXUIElement?
        if let index = input["index"] {
            guard let i = integer(index), elements.indices.contains(i) else { throw failure("STALE_SNAPSHOT", "Invalid AX index.") }
            element = elements[i]
            guard fingerprints[i] == fingerprint(element!) else { throw failure("STALE_SNAPSHOT", "AX element content changed since observation. Read fresh state.") }
            let owner = ownerWindow(element!)
            if let current, let owner, !CFEqual(current, owner) { throw failure("TARGET_CHANGED", "Element belongs to a different window.") }
            if let prior = elementWindows[i] {
                guard let owner, CFEqual(prior, owner), let before = elementBounds[i], let now = rect(owner), sameRect(before, now) else { throw failure("TARGET_CHANGED", "Element window changed. Observe again.") }
            } else if owner != nil { throw failure("TARGET_CHANGED", "Element acquired a different window. Observe again.") }
            var pid: pid_t = 0
            guard !hasSecureAncestor(element!), AXUIElementGetPid(element!, &pid) == .success, pid == (try app()).processIdentifier,
                  !stringAttribute(element!, kAXRoleAttribute).isEmpty else { throw failure("TARGET_CHANGED", "Element is secure, missing or no longer owned by this app.") }
            guard (attribute(element!, kAXEnabledAttribute) as? Bool) != false else { throw failure("UNSUPPORTED", "Element is disabled.") }
        }
        return (current, bounds, element)
    }
    func act(_ method: String, _ input: [String: Any]) async throws -> [String: Any] {
        defer { invalidate() }
        let (window, bounds, element) = try checkedSnapshot(input)
        // AXPress may synchronously finish a sheet animation before replying.
        // The short observation timeout must not become the action timeout.
        if let element { AXUIElementSetMessagingTimeout(element, 1.0) }
        let status: AXError
        switch method {
        case "click", "perform_action":
            guard let element else { throw failure("INVALID_INPUT", "An element ref is required.") }
            let action = method == "click" ? kAXPressAction : input["action"] as? String ?? ""
            guard actionNames(element).contains(action) else { throw failure("UNSUPPORTED", "Element does not expose the requested AX action. Read its actions list.") }
            status = AXUIElementPerformAction(element, action as CFString)
        case "focus", "select_text":
            guard let element else { throw failure("INVALID_INPUT", "An element ref is required.") }
            let name = method == "focus" ? kAXFocusedAttribute : kAXSelectedTextRangeAttribute
            var settable: DarwinBoolean = false
            guard AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success, settable.boolValue else {
                throw failure("UNSUPPORTED", "Requested AX attribute is not writable. No keyboard fallback was attempted.")
            }
            if method == "focus" { status = AXUIElementSetAttributeValue(element, name as CFString, kCFBooleanTrue) }
            else {
                guard let selection = input["selection"] as? [String: Any],
                      let raw = attribute(element, kAXValueAttribute), CFGetTypeID(raw) == CFStringGetTypeID() else { throw failure("UNSUPPORTED", "Element does not expose a text value.") }
                var range = try textSelection(String(describing: raw), selection)
                guard let value = AXValueCreate(.cfRange, &range) else { throw failure("NATIVE_ERROR", "Cannot encode AX text selection.") }
                status = AXUIElementSetAttributeValue(element, name as CFString, value)
            }
        case "set_value":
            guard let element, let value = input["value"] as? String, value.utf16.count <= 4096 else { throw failure("INVALID_INPUT", "Invalid set_value input.") }
            var settable: DarwinBoolean = false
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { throw failure("UNSUPPORTED", "AXValue is not writable.") }
            status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        case "click_at", "press_key", "type_text", "scroll":
            guard let window, let bounds else { throw failure("UNSUPPORTED", "Physical input requires a window snapshot; read get_state with window scope first.") }
            let keyboard = method == "press_key" || method == "type_text"
            let appRoot = AXUIElementCreateApplication(try app().processIdentifier)
            func focusedElement() -> AXUIElement? {
                guard let value = attribute(appRoot, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
                return unsafeBitCast(value, to: AXUIElement.self)
            }
            // Finder exposes its rename editor in AXWindows, without AXWindow
            // or AXFocusedWindow. It must already be the exact focused surface.
            let topLevelEditor = stringAttribute(window, kAXRoleAttribute) == kAXTextFieldRole
            if topLevelEditor {
                guard keyboard else { throw failure("UNSUPPORTED", "Top-level text editors support keyboard input only; select a real window for pointer input.") }
                guard let focused = focusedElement(), CFEqual(focused, window),
                      element == nil || CFEqual(element!, window) else {
                    throw failure("TARGET_CHANGED", "The selected top-level editor is not the keyboard focus. Observe again.")
                }
            } else if stringAttribute(window, kAXRoleAttribute) != kAXWindowRole {
                throw failure("UNSUPPORTED", "This AX top-level surface does not support physical input.")
            }
            // Validate all payloads before any foreground/focus side effect.
            let key = method == "press_key" ? try parseKey(input["key"] as? String ?? "") : nil
            let text = input["text"] as? String ?? ""
            if method == "type_text" && (text.isEmpty || text.utf16.count > 4096) { throw failure("INVALID_INPUT", "Invalid text.") }
            var point = CGPoint(x: bounds.midX, y: bounds.midY)
            if method == "click_at" {
                guard let x = number(input["x"]), let y = number(input["y"]), x >= 0, y >= 0, x < bounds.width, y < bounds.height,
                      ["left", "right"].contains(input["button"] as? String ?? ""), let count = integer(input["clickCount"]), (1...3).contains(count) else { throw failure("INVALID_INPUT", "Point must be within the observed window in window-local points.") }
                point = CGPoint(x: bounds.minX + x, y: bounds.minY + y)
            }
            if method == "scroll", !["up", "down", "left", "right"].contains(input["direction"] as? String ?? "") { throw failure("INVALID_INPUT", "Invalid scroll direction.") }
            if let element {
                if method == "scroll" {
                    guard let b = rect(element), bounds.intersects(b) else { throw failure("TARGET_CHANGED", "Scroll target has no visible bounds.") }
                    point = CGPoint(x: b.intersection(bounds).midX, y: b.intersection(bounds).midY)
                } else if !topLevelEditor {
                    let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    guard focused == .success else { throw failure("UNSUPPORTED", "Cannot focus this AX element.", "unknown") }
                }
            }
            let target = try app()
            // Bring exactly this window forward. Never send global input to a
            // different foreground application after user takeover.
            if !topLevelEditor {
                guard target.activate(options: []) else { throw failure("NATIVE_ERROR", "Cannot activate target application.", "unknown") }
                guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { throw failure("UNSUPPORTED", "Cannot raise selected window.", "unknown") }
                for _ in 0..<20 {
                    if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier { break }
                    try await Task.sleep(nanoseconds: 25_000_000)
                }
            }
            func foreground() throws {
                // A top-level rename field resizes as text arrives. Keyboard
                // delivery follows its exact focus/identity, never coordinates.
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier,
                      let live = rect(window), topLevelEditor || sameRect(bounds, live) else { throw failure("TARGET_CHANGED", "User changed the foreground app/window. Input stopped.", "unknown") }
                if topLevelEditor {
                    guard let focused = focusedElement(), CFEqual(focused, window),
                          let live = attribute(appRoot, kAXWindowsAttribute) as? [AXUIElement], live.contains(where: { CFEqual($0, window) }) else {
                        throw failure("TARGET_CHANGED", "Top-level editor focus or identity changed. Input stopped.", "unknown")
                    }
                    return
                }
                guard let focused = attribute(appRoot, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window) else { throw failure("TARGET_CHANGED", "Selected window is no longer focused. Input stopped.", "unknown") }
            }
            try foreground()
            let expectedFocus = keyboard ? (element ?? focusedElement()) : nil
            func keyboardFocus() throws {
                try foreground()
                let current = focusedElement()
                if let expectedFocus {
                    var owner: pid_t = 0
                    guard let current, CFEqual(current, expectedFocus),
                          AXUIElementGetPid(current, &owner) == .success, owner == target.processIdentifier,
                          !hasSecureAncestor(current),
                          (topLevelEditor ? CFEqual(current, window) : ownerWindow(current).map { CFEqual($0, window) } == true) else {
                        throw failure("TARGET_CHANGED", "Keyboard focus changed, is secure or cannot be verified in the selected window. Input stopped.", "unknown")
                    }
                } else if current != nil || method == "type_text" {
                    throw failure("UNSUPPORTED", "Cannot verify the keyboard target. No keyboard input was sent.", "unknown")
                }
            }
            if keyboard { try keyboardFocus() }
            if method == "click_at" {
                let button: CGMouseButton = input["button"] as? String == "right" ? .right : .left
                let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
                let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
                let count = integer(input["clickCount"])!
                for i in 1...count {
                    try foreground()
                    guard let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button),
                          let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button) else { throw failure("NATIVE_ERROR", "Cannot create mouse events.", "unknown") }
                    d.setIntegerValueField(.mouseEventClickState, value: Int64(i)); u.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                    d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
                }
            } else if method == "press_key", let (code, flags) = key {
                guard let d = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let u = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw failure("NATIVE_ERROR", "Cannot create key events.", "unknown") }
                d.flags = flags; u.flags = flags
                try keyboardFocus()
                d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
            } else if method == "type_text" {
                try await sendUnicodeText(text, checkFocus: keyboardFocus)
            } else if method == "scroll" {
                let amount = integer(input["amount"]) ?? 400
                guard (1...2000).contains(amount) else { throw failure("INVALID_INPUT", "Invalid scroll amount.", "unknown") }
                let direction = input["direction"] as! String
                let dy = direction == "up" ? amount : direction == "down" ? -amount : 0
                let dx = direction == "left" ? amount : direction == "right" ? -amount : 0
                guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
                      let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { throw failure("NATIVE_ERROR", "Cannot create scroll events.", "unknown") }
                move.post(tap: .cghidEventTap); event.location = point; event.post(tap: .cghidEventTap)
            }
            status = .success
        default: throw failure("UNSUPPORTED", "Unsupported native action.")
        }
        guard status == .success else { throw failure("NATIVE_ERROR", "AX action returned \(status.rawValue). Observe before repeating.", "unknown") }
        return ["performed": true, "observeRequired": true]
    }
    func screenshot(_ input: [String: Any]) async throws -> [String: Any] {
        invalidate()
        guard #available(macOS 14.4, *) else { throw failure("UNSUPPORTED", "Window screenshots require macOS 14.4 or newer. AX remains available.") }
        guard CGPreflightScreenCaptureAccess() else { throw failure("PERMISSION_REQUIRED", "Grant Screen Recording to Hanekawa in System Settings > Privacy & Security > Screen Recording.") }
        guard let id = input["windowId"] as? String else { throw failure("INVALID_INPUT", "windowId is required.") }
        let selected = try window(id)
        guard let bounds = rect(selected) else { throw failure("TARGET_CHANGED", "Window bounds unavailable.") }
        let pid = try app().processIdentifier
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let matches = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && sameRect($0.frame, bounds) }
        guard matches.count == 1, let captured = matches.first else { throw failure("UNSUPPORTED", "Cannot uniquely match this AX window to a capture window. No screenshot was taken.") }
        let config = SCStreamConfiguration()
        let scale = min(2, 2048 / max(bounds.width, bounds.height))
        config.width = max(1, Int(bounds.width * scale)); config.height = max(1, Int(bounds.height * scale)); config.showsCursor = false
        // Shadows add pixels outside AX bounds and would shift click_at.
        config.ignoreShadowsSingleWindow = true
        config.ignoreGlobalClipSingleWindow = true
        config.includeChildWindows = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: captured), configuration: config)
        guard let current = rect(try window(id)), sameRect(bounds, current), try app().processIdentifier == pid else { throw failure("TARGET_CHANGED", "Window changed during capture.") }
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count < 16_000_000 else { throw failure("NATIVE_ERROR", "Cannot encode bounded window PNG.") }
        revision += 1; observedScope = "window"; observedWindow = selected; observedBounds = bounds; observedWindowID = id
        return ["revision": revision, "processId": pid, "windowId": id, "bounds": jsonRect(bounds), "sampledAt": Date().timeIntervalSince1970 * 1000, "windowNumber": captured.windowID,
            "width": image.width, "height": image.height, "png": png.base64EncodedString()]
    }
}

func parseKey(_ key: String) throws -> (CGKeyCode, CGEventFlags) {
    var parts = key.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard let last = parts.popLast(), !last.isEmpty else { throw failure("INVALID_INPUT", "Invalid key combination.") }
    var flags: CGEventFlags = []
    for modifier in parts {
        switch modifier {
        case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "alt", "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: throw failure("INVALID_INPUT", "Unknown key modifier.")
        }
    }
    let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
        "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"return":36,"enter":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"`":50,"backspace":51,"escape":53,"esc":53,"home":115,"pageup":116,"delete":117,"end":119,"pagedown":121,"left":123,"right":124,"down":125,"up":126]
    guard let code = codes[last] else { throw failure("INVALID_INPUT", "Unsupported key. Use type_text for Unicode text.") }
    return (code, flags)
}

@main struct Main {
    @MainActor static func main() async {
        if CommandLine.arguments.contains("--self-test") {
            precondition(integer(NSNumber(value: true)) == nil && integer(NSNumber(value: 1.5)) == nil && integer(NSNumber(value: 2)) == 2)
            precondition(number(NSNumber(value: true)) == nil)
            precondition((try? parseKey("cmd+s"))?.0 == 1 && (try? parseKey("bad+s")) == nil)
            let family = "👨‍👩‍👧‍👦"
            precondition(boundedText(String(repeating: family, count: 200), limit: 200) == String(repeating: family, count: 18))
            precondition(boundedText("a😀b", limit: 3) == "a😀")
            precondition(boundedText("e\u{301}x", limit: 1).isEmpty)
            testElementIdentities()
            testTextSelection()
            try! await testKeyboardInput()
            print("{\"passed\":true,\"scope\":\"protocol helpers only; no GUI access\"}"); return
        }
        // ScreenCaptureKit window filters require AppKit/WindowServer initialization.
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let session = AppSession()
        while let line = readLine() {
            var response: [String: Any] = ["id": NSNull()]
            do {
                guard let data = line.data(using: .utf8), data.count <= 65536,
                      let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = integer(input["id"]), id > 0, let method = input["method"] as? String else { throw failure("INVALID_INPUT", "Invalid JSONL request.") }
                response["id"] = id
                let result: Any
                switch method {
                case "status":
                    var supported = false
                    if #available(macOS 14.4, *) { supported = true }
                    result = ["protocol": protocolVersion, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "screenshotSupported": supported]
                case "list_apps":
                    result = Array(NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.bundleIdentifier != nil && $0.activationPolicy == .regular }.prefix(500)).map {
                        ["bundleId": boundedText($0.bundleIdentifier!, limit: 500), "name": boundedText($0.localizedName ?? "", limit: 200), "processId": $0.processIdentifier] as [String: Any]
                    }
                case "bind":
                    guard let target = input["app"] as? String else { throw failure("INVALID_INPUT", "app is required.") }
                    result = try session.bind(target)
                case "list_windows": result = try session.listWindows()
                case "observe": result = try session.observe(input)
                case "observe_with_screenshot": result = try await session.observeWithScreenshot(input)
                case "screenshot": result = try await session.screenshot(input)
                case "click", "focus", "select_text", "set_value", "perform_action", "click_at", "press_key", "type_text", "scroll": result = try await session.act(method, input)
                default: throw failure("UNSUPPORTED", "Unknown native operation.")
                }
                response["result"] = result
            } catch let error as BridgeFailure {
                response["error"] = ["code": error.code, "message": error.message, "delivery": error.delivery]
            } catch { response["error"] = ["code": "NATIVE_ERROR", "message": "macOS operation failed: \(String(describing: error).prefix(500))", "delivery": "unknown"] }
            guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), data.count < 24 * 1024 * 1024,
                  let text = String(data: data, encoding: .utf8) else { return }
            print(text); fflush(stdout)
        }
    }
}
