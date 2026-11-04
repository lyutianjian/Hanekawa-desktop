import Foundation
import ApplicationServices

func ownerWindow(_ element: AXUIElement) -> AXUIElement? {
    guard let owner = attribute(element, kAXWindowAttribute), CFGetTypeID(owner) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(owner, to: AXUIElement.self)
}

func hasSecureAncestor(_ element: AXUIElement) -> Bool {
    var current = element
    for _ in 0..<24 {
        if secure(current) { return true }
        guard let parent = attribute(current, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
        let next = unsafeBitCast(parent, to: AXUIElement.self)
        if CFEqual(next, current) { return true }
        current = next
    }
    return true
}

@MainActor extension AppSession {
    func observe(_ input: [String: Any]) throws -> [String: Any] {
        let priorElements = elements; let priorFingerprints = fingerprints
        let priorWindow = observedWindow; let priorScope = observedScope
        let rootIndex = integer(input["rootIndex"])
        let oldRevision = integer(input["revision"])
        invalidate()
        try requireAX()
        let pid = try app().processIdentifier
        let appRoot = AXUIElementCreateApplication(pid)
        let scope = input["scope"] as? String ?? "window"
        guard ["window", "application"].contains(scope) else { throw failure("INVALID_INPUT", "Unknown observation scope.") }
        var selected: AXUIElement?
        var bounds: CGRect?
        var root = appRoot
        let id = input["windowId"] as? String
        if scope == "window" {
            guard let id else { throw failure("INVALID_INPUT", "windowId is required.") }
            let window = try self.window(id)
            guard let frame = rect(window) else { throw failure("TARGET_CHANGED", "Window bounds unavailable.") }
            selected = window; bounds = frame; root = window
        } else {
            guard id == nil else { throw failure("INVALID_INPUT", "Application scope does not select a window.") }
            _ = try listWindows()
        }
        if let index = rootIndex {
            guard oldRevision == revision, priorScope == scope, priorElements.indices.contains(index),
                  (scope == "application" || (priorWindow != nil && selected != nil && CFEqual(priorWindow!, selected!))),
                  priorFingerprints[index] == fingerprint(priorElements[index]) else { throw failure("STALE_SNAPSHOT", "Subtree reference expired.") }
            root = priorElements[index]
        }
        revision += 1
        observedScope = scope; observedWindow = selected; observedBounds = bounds; observedWindowID = id
        var nodes: [[String: Any]] = []
        var truncated = false
        var succeeded = false
        identities.begin(window: selected ?? appRoot, subtree: rootIndex != nil)
        defer { identities.finish(complete: succeeded && !truncated && rootIndex == nil) }
        let start = ProcessInfo.processInfo.systemUptime
        var seen: [CFHashCode: [AXUIElement]] = [:]
        func walk(_ element: AXUIElement, _ depth: Int, _ parent: String?) {
            guard depth <= 24, elements.count < 1000, ProcessInfo.processInfo.systemUptime - start < 3 else { truncated = true; return }
            let hash = CFHash(element)
            guard !(seen[hash] ?? []).contains(where: { CFEqual($0, element) }) else { return }
            seen[hash, default: []].append(element)
            var ownerPID: pid_t = 0
            guard AXUIElementGetPid(element, &ownerPID) == .success, ownerPID == pid else { truncated = true; return }
            AXUIElementSetMessagingTimeout(element, 0.25)
            let owner = ownerWindow(element)
            if let selected, let owner, !CFEqual(selected, owner) { truncated = true; return }
            let index = elements.count; elements.append(element)
            let key = fingerprint(element)
            fingerprints.append(key)
            elementWindows.append(owner); elementBounds.append(owner.flatMap { rect($0) })
            let identity = identities.identify(element, fingerprint: key, parent: parent)
            let password = secure(element)
            let role = stringAttribute(element, kAXRoleAttribute, limit: 50)
            let label = password ? "[secure field]" : [stringAttribute(element, kAXTitleAttribute, limit: 100), stringAttribute(element, kAXDescriptionAttribute, limit: 100)].filter { !$0.isEmpty }.joined(separator: " ")
            var writable: [String] = []
            if !password {
                for name in [kAXValueAttribute, kAXFocusedAttribute, kAXSelectedTextRangeAttribute] {
                    var settable: DarwinBoolean = false
                    if AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success, settable.boolValue { writable.append(name) }
                }
            }
            var node: [String: Any] = ["index": index, "identity": identity, "depth": depth, "role": role, "label": label,
                "value": password ? "[redacted]" : stringAttribute(element, kAXValueAttribute),
                "actions": password ? [] : actionNames(element), "settable": writable.contains(kAXValueAttribute), "writableAttributes": writable,
                "enabled": (attribute(element, kAXEnabledAttribute) as? Bool) ?? true]
            if !password, let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() {
                var range = CFRange()
                if AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cfRange, &range), range.location >= 0, range.length >= 0 {
                    node["selectedTextRange"] = ["start": range.location, "length": range.length]
                }
            }
            if let owner, let handle = windows.first(where: { CFEqual($0.1, owner) })?.0 { node["windowId"] = handle }
            if let b = rect(element) { node["bounds"] = jsonRect(b) }
            nodes.append(node)
            // Never traverse secure-field descendants or cross an app boundary.
            guard !password else { return }
            var children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            if CFEqual(element, appRoot) {
                var extras: [AXUIElement] = []
                for name in [kAXMenuBarAttribute, kAXFocusedWindowAttribute, kAXFocusedUIElementAttribute] {
                    if let extra = attribute(element, name), CFGetTypeID(extra) == AXUIElementGetTypeID() {
                        let child = unsafeBitCast(extra, to: AXUIElement.self)
                        if !hasSecureAncestor(child) { extras.append(child) }
                    }
                }
                children = extras + windows.map { $0.1 } + children
            }
            for child in children {
                if elements.count >= 1000 || ProcessInfo.processInfo.systemUptime - start >= 3 { truncated = true; break }
                walk(child, depth + 1, identity)
            }
        }
        walk(root, 0, nil)
        let liveWindows = try listWindows()
        if let selected, let initial = bounds, let id {
            guard let live = windows.first(where: { $0.0 == id })?.1, CFEqual(selected, live),
                  let frame = rect(live), sameRect(initial, frame) || stringAttribute(live, kAXRoleAttribute) == kAXTextFieldRole else { throw failure("TARGET_CHANGED", "Window changed during AX sampling.") }
            // Top-level editors grow with their content; they authorize keyboard
            // input only. Publish their latest bounds without retaining old ones.
            bounds = frame
            observedBounds = frame
        }
        _ = try app()
        succeeded = true
        var result: [String: Any] = ["revision": revision, "processId": pid, "scope": scope,
            "sampledAt": Date().timeIntervalSince1970 * 1000, "windows": liveWindows, "nodes": nodes, "truncated": truncated]
        if let id, let bounds { result["windowId"] = id; result["bounds"] = jsonRect(bounds) }
        return result
    }

    func observeWithScreenshot(_ input: [String: Any]) async throws -> [String: Any] {
        // Separate public API samples, deliberately not advertised as atomic.
        let shot = try await screenshot(input)
        guard let selected = observedWindow, let bounds = observedBounds else { throw failure("TARGET_CHANGED", "Captured window is unavailable.") }
        let observation = try observe(input)
        guard let current = observedWindow, CFEqual(current, selected), let now = observedBounds, sameRect(bounds, now) else {
            invalidate()
            throw failure("TARGET_CHANGED", "Window changed between screenshot and AX sampling.")
        }
        return ["screenshot": shot, "observation": observation]
    }
}
