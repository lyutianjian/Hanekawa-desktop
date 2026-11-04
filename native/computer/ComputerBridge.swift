// Hanekawa's public-API macOS driver. Private child stdio; no network service,
// arbitrary scripts, Codex binaries or proprietary implementation code.
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

let protocolVersion = "hanekawa-computer/1"
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
func stringAttribute(_ element: AXUIElement, _ name: String, limit: Int = 200) -> String {
    guard let value = attribute(element, name) else { return "" }
    guard CFGetTypeID(value) == CFStringGetTypeID() || CFGetTypeID(value) == CFNumberGetTypeID() else { return "" }
    // Keep the UTF-16 length within the TS protocol's string budget too.
    return String(String(describing: value).prefix(limit))
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
    [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, kAXValueAttribute].map { stringAttribute(element, $0) }
}
func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return Array((names as? [String] ?? []).prefix(32)).map { String($0.prefix(50)) }
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
    var observedWindow: AXUIElement?
    var observedBounds: CGRect?
    var observedWindowID: String?

    func invalidate() { elements.removeAll(); fingerprints.removeAll(); observedWindow = nil; observedBounds = nil; observedWindowID = nil }
    func app() throws -> NSRunningApplication {
        guard let app = pinnedApp, !app.isTerminated,
              let live = NSRunningApplication(processIdentifier: app.processIdentifier), live.launchDate == launchDate,
              live.bundleIdentifier == app.bundleIdentifier else { invalidate(); throw failure("TARGET_CHANGED", "Target process exited or restarted. Bind it again.") }
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
        return ["protocol": protocolVersion, "bundleId": selected.bundleIdentifier!, "name": String((selected.localizedName ?? "").prefix(200)), "processId": selected.processIdentifier, "windows": rows]
    }
    func listWindows() throws -> [[String: Any]] {
        try requireAX()
        let root = AXUIElementCreateApplication(try app().processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.5)
        guard let live = attribute(root, kAXWindowsAttribute) as? [AXUIElement] else { throw failure("NATIVE_ERROR", "Application did not expose its AX windows.") }
        guard live.count <= 100 else { throw failure("UNSUPPORTED", "Too many application windows.") }
        var current: [(String, AXUIElement)] = []
        for element in live {
            AXUIElementSetMessagingTimeout(element, 0.5)
            guard rect(element) != nil else { continue }
            if let previous = windows.first(where: { CFEqual($0.1, element) }) { current.append(previous) }
            else { current.append(("w\(nextWindow)", element)); nextWindow += 1 }
        }
        windows = current
        return current.compactMap { id, element -> [String: Any]? in
            guard let bounds = rect(element) else { return nil }
            return ["id": id, "title": stringAttribute(element, kAXTitleAttribute), "bounds": jsonRect(bounds)]
        }
    }
    func window(_ id: String) throws -> AXUIElement {
        _ = try listWindows()
        guard let selected = windows.first(where: { $0.0 == id })?.1 else { throw failure("TARGET_CHANGED", "Selected window closed. Read get_state and choose a current window.") }
        return selected
    }
    func observe(_ input: [String: Any]) throws -> [String: Any] {
        let priorElements = elements; let priorWindow = observedWindow
        let rootIndex = integer(input["rootIndex"])
        let oldRevision = integer(input["revision"])
        invalidate()
        guard let id = input["windowId"] as? String else { throw failure("INVALID_INPUT", "windowId is required.") }
        let selected = try window(id)
        var root = selected
        if let index = rootIndex {
            guard oldRevision == revision, priorElements.indices.contains(index), let old = priorWindow, CFEqual(old, selected) else { throw failure("STALE_SNAPSHOT", "Subtree reference expired.") }
            root = priorElements[index]
        }
        guard let bounds = rect(selected) else { throw failure("TARGET_CHANGED", "Window bounds are unavailable.") }
        revision += 1
        observedWindow = selected; observedBounds = bounds; observedWindowID = id
        var nodes: [[String: Any]] = []
        var truncated = false
        let start = ProcessInfo.processInfo.systemUptime
        var seen: [CFHashCode: [AXUIElement]] = [:]
        func walk(_ element: AXUIElement, _ depth: Int) {
            guard depth <= 24, elements.count < 1000, ProcessInfo.processInfo.systemUptime - start < 3 else { truncated = true; return }
            let hash = CFHash(element)
            guard !(seen[hash] ?? []).contains(where: { CFEqual($0, element) }) else { return }
            seen[hash, default: []].append(element)
            AXUIElementSetMessagingTimeout(element, 0.25)
            let index = elements.count; elements.append(element)
            fingerprints.append(fingerprint(element))
            let password = secure(element)
            let role = stringAttribute(element, kAXRoleAttribute, limit: 50)
            let label = password ? "[secure field]" : [stringAttribute(element, kAXTitleAttribute, limit: 100), stringAttribute(element, kAXDescriptionAttribute, limit: 100)].filter { !$0.isEmpty }.joined(separator: " ")
            var settable: DarwinBoolean = false
            if !password { AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) }
            var node: [String: Any] = ["index": index, "depth": depth, "role": role, "label": label,
                "value": password ? "[redacted]" : stringAttribute(element, kAXValueAttribute),
                "actions": password ? [] : actionNames(element), "settable": settable.boolValue,
                "enabled": (attribute(element, kAXEnabledAttribute) as? Bool) ?? true]
            if let b = rect(element) { node["bounds"] = jsonRect(b) }
            nodes.append(node)
            if !password, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                for child in children {
                    if elements.count >= 1000 || ProcessInfo.processInfo.systemUptime - start >= 3 { truncated = true; break }
                    walk(child, depth + 1)
                }
            }
        }
        walk(root, 0)
        return ["revision": revision, "processId": try app().processIdentifier, "windowId": id,
            "windows": try listWindows(), "bounds": jsonRect(bounds), "nodes": nodes, "truncated": truncated]
    }
    func checkedSnapshot(_ input: [String: Any]) throws -> (AXUIElement, CGRect, AXUIElement?) {
        try requireAX()
        guard integer(input["revision"]) == revision, let old = observedWindow, let bounds = observedBounds,
              let id = observedWindowID else { throw failure("STALE_SNAPSHOT", "Read fresh state before acting.") }
        let current = try window(id)
        guard CFEqual(current, old), let liveBounds = rect(current), sameRect(bounds, liveBounds) else { throw failure("TARGET_CHANGED", "Window moved, resized or changed. Observe again.") }
        var element: AXUIElement?
        if let index = input["index"] {
            guard let i = integer(index), elements.indices.contains(i) else { throw failure("STALE_SNAPSHOT", "Invalid AX index.") }
            element = elements[i]
            guard fingerprints.indices.contains(i), fingerprints[i] == fingerprint(element!) else { throw failure("STALE_SNAPSHOT", "AX element content changed since observation. Read fresh state.") }
            if let ownerWindow = attribute(element!, kAXWindowAttribute), CFGetTypeID(ownerWindow) == AXUIElementGetTypeID(), !CFEqual(ownerWindow, current) {
                throw failure("TARGET_CHANGED", "Element moved to a different window.")
            }
            var pid: pid_t = 0
            guard !secure(element!), AXUIElementGetPid(element!, &pid) == .success, pid == (try app()).processIdentifier,
                  !stringAttribute(element!, kAXRoleAttribute).isEmpty else { throw failure("TARGET_CHANGED", "Element is secure, missing or no longer owned by this app.") }
            guard (attribute(element!, kAXEnabledAttribute) as? Bool) != false else { throw failure("UNSUPPORTED", "Element is disabled.") }
        }
        return (current, bounds, element)
    }
    func act(_ method: String, _ input: [String: Any]) async throws -> [String: Any] {
        defer { invalidate() }
        let (window, bounds, element) = try checkedSnapshot(input)
        let status: AXError
        switch method {
        case "click", "perform_action":
            guard let element else { throw failure("INVALID_INPUT", "An element ref is required.") }
            let action = method == "click" ? kAXPressAction : input["action"] as? String ?? ""
            guard actionNames(element).contains(action) else { throw failure("UNSUPPORTED", "Element does not expose the requested AX action. Read its actions list.") }
            status = AXUIElementPerformAction(element, action as CFString)
        case "set_value":
            guard let element, let value = input["value"] as? String, value.utf16.count <= 4096 else { throw failure("INVALID_INPUT", "Invalid set_value input.") }
            var settable: DarwinBoolean = false
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { throw failure("UNSUPPORTED", "AXValue is not writable.") }
            status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        case "click_at", "press_key", "type_text", "scroll":
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
                } else {
                    let focused = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                    guard focused == .success else { throw failure("UNSUPPORTED", "Cannot focus this AX element.", "unknown") }
                }
            }
            let target = try app()
            // Bring exactly this window forward. Never send global input to a
            // different foreground application after user takeover.
            guard target.activate(options: []) else { throw failure("NATIVE_ERROR", "Cannot activate target application.", "unknown") }
            guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { throw failure("UNSUPPORTED", "Cannot raise selected window.", "unknown") }
            for _ in 0..<20 {
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier { break }
                try await Task.sleep(nanoseconds: 25_000_000)
            }
            func foreground() throws {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.processIdentifier,
                      let live = rect(window), sameRect(bounds, live) else { throw failure("TARGET_CHANGED", "User changed the foreground app/window. Input stopped.", "unknown") }
                let appRoot = AXUIElementCreateApplication(target.processIdentifier)
                guard let focused = attribute(appRoot, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window) else { throw failure("TARGET_CHANGED", "Selected window is no longer focused. Input stopped.", "unknown") }
            }
            try foreground()
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
                d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
            } else if method == "type_text" {
                // Unicode events, rather than temporary clipboard replacement.
                for character in text {
                    try foreground()
                    let units = Array(String(character).utf16)
                    guard let d = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), let u = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw failure("NATIVE_ERROR", "Cannot create text events.", "unknown") }
                    units.withUnsafeBufferPointer { buffer in
                        d.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
                        u.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress)
                    }
                    d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
                }
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
        // Allow dispatched input to reach the app before the host observes.
        // Bounded; cancellation kills this helper rather than leaving a waiter.
        try await Task.sleep(nanoseconds: 120_000_000)
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
        revision += 1; observedWindow = selected; observedBounds = bounds; observedWindowID = id
        return ["revision": revision, "processId": pid, "windowId": id, "bounds": jsonRect(bounds), "windowNumber": captured.windowID,
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
            print("{\"passed\":true,\"scope\":\"protocol helpers only; no GUI access\"}"); return
        }
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
                        ["bundleId": String($0.bundleIdentifier!.prefix(500)), "name": String(($0.localizedName ?? "").prefix(200)), "processId": $0.processIdentifier] as [String: Any]
                    }
                case "bind":
                    guard let target = input["app"] as? String else { throw failure("INVALID_INPUT", "app is required.") }
                    result = try session.bind(target)
                case "list_windows": result = try session.listWindows()
                case "observe": result = try session.observe(input)
                case "screenshot": result = try await session.screenshot(input)
                case "click", "set_value", "perform_action", "click_at", "press_key", "type_text", "scroll": result = try await session.act(method, input)
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
