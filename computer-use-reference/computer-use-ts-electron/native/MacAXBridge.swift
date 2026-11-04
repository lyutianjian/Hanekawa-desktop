// Independent reference implementation, based on the earlier independently authored AX prototype.
// Not recovered OpenAI source; no Codex paths, private IPC, or private macOS APIs.
// macOS 14.4+; one already-running app, exactly one AX window, private child stdio.
import Foundation
import AppKit
import ApplicationServices

enum BridgeError: Error { case code(String) }
func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let d = number.doubleValue
    guard d.isFinite, d >= 0, d < Double(Int.max), d.rounded() == d else { return nil }
    return Int(d)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func stringAttribute(_ element: AXUIElement, _ name: String, max: Int = 100) -> String {
    guard let value = attribute(element, name) else { return "" }
    if CFGetTypeID(value) == CFStringGetTypeID() || CFGetTypeID(value) == CFNumberGetTypeID() {
        return String(String(describing: value).prefix(max))
    }
    return ""
}

@MainActor final class AppSession {
    let bundleID: String
    var pinnedPID: pid_t?
    var pinnedLaunchDate: Date?
    var revision = 0
    var elements: [AXUIElement] = []
    var observedWindow: AXUIElement?
    init(bundleID: String) { self.bundleID = bundleID }
    func app() throws -> NSRunningApplication {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard apps.count == 1, let app = apps.first, !app.isTerminated else { throw BridgeError.code("TARGET_CHANGED") }
        if let pid = pinnedPID {
            guard app.processIdentifier == pid, app.launchDate == pinnedLaunchDate else {
                elements.removeAll(); throw BridgeError.code("TARGET_CHANGED")
            }
        } else { pinnedPID = app.processIdentifier; pinnedLaunchDate = app.launchDate }
        return app
    }
    func window() throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw BridgeError.code("PERMISSION_REQUIRED") }
        let root = AXUIElementCreateApplication(try app().processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.5)
        guard let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 else {
            throw BridgeError.code("UNSUPPORTED")
        }
        return windows[0]
    }
    func hello() throws -> [String: Any] {
        return ["protocol": "cu-reference/1", "bundleId": bundleID, "processId": try app().processIdentifier]
    }
    func observe() throws -> [String: Any] {
        elements.removeAll(); observedWindow = nil
        let root = try window()
        observedWindow = root; revision += 1
        var nodes: [[String: Any]] = []
        var lines: [String] = []
        var truncated = false
        let start = ProcessInfo.processInfo.systemUptime
        func walk(_ element: AXUIElement, depth: Int) {
            guard depth <= 24, elements.count < 1000, ProcessInfo.processInfo.systemUptime - start < 3 else {
                truncated = true; return
            }
            AXUIElementSetMessagingTimeout(element, 0.5)
            let index = elements.count
            elements.append(element)
            let role = stringAttribute(element, kAXRoleAttribute)
            let title = stringAttribute(element, kAXTitleAttribute)
            let detail = stringAttribute(element, kAXDescriptionAttribute)
            let label = [title, detail].filter { !$0.isEmpty }.joined(separator: " ")
            // Password values and descendants are never included in the observation.
            let secure = stringAttribute(element, kAXSubroleAttribute) == "AXSecureTextField"
            let value = secure ? "[redacted]" : stringAttribute(element, kAXValueAttribute)
            var actions: CFArray?
            var names: [String] = []
            if !secure, AXUIElementCopyActionNames(element, &actions) == .success {
                names = Array((actions as? [String] ?? []).prefix(32)).map { String($0.prefix(100)) }
            }
            nodes.append(["index": index, "depth": depth, "role": role, "label": label, "value": value, "actions": names])
            lines.append(String(repeating: "  ", count: depth) + "\(index) \(role) \(label) \(value)")
            if !secure, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                for child in children { walk(child, depth: depth + 1) }
            }
        }
        walk(root, depth: 0)
        return ["revision": revision, "processId": try app().processIdentifier, "text": lines.joined(separator: "\n"), "nodes": nodes, "truncated": truncated]
    }
    func act(_ method: String, _ input: [String: Any]) throws -> [String: Any] {
        // Invalidate on all attempts. App/window identity is checked before resolving an index.
        defer { elements.removeAll(); observedWindow = nil }
        let liveWindow = try window()
        guard let old = observedWindow, CFEqual(old, liveWindow) else { throw BridgeError.code("TARGET_CHANGED") }
        guard integer(input["revision"]) == revision,
              let index = integer(input["index"]), elements.indices.contains(index) else { throw BridgeError.code("STALE_SNAPSHOT") }
        let element = elements[index]
        guard stringAttribute(element, kAXSubroleAttribute) != "AXSecureTextField" else { throw BridgeError.code("UNSUPPORTED") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == pinnedPID else { throw BridgeError.code("TARGET_CHANGED") }
        let status: AXError
        if method == "press" {
            status = AXUIElementPerformAction(element, kAXPressAction as CFString)
        } else {
            guard let value = input["value"] as? String, value.utf16.count <= 4096 else { throw BridgeError.code("NATIVE_ERROR") }
            var settable: DarwinBoolean = false
            guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else {
                throw BridgeError.code("UNSUPPORTED")
            }
            status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        }
        guard status == .success else { throw BridgeError.code("NATIVE_ERROR") }
        return ["performed": true, "observeRequired": true]
    }
}

@main struct Main {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--self-test") {
            precondition(integer(NSNumber(value: true)) == nil)
            precondition(integer(NSNumber(value: 1.5)) == nil)
            precondition(integer(NSNumber(value: -1)) == nil)
            precondition(integer(NSNumber(value: 2)) == 2)
            print("{\"passed\":true,\"scope\":\"integer validation only; no desktop access\"}")
            return
        }
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == "com.apple.calculator" else {
            fputs("Only the configured Calculator bundle is supported\n", stderr); return
        }
        let session = AppSession(bundleID: CommandLine.arguments[1])
        while let line = readLine() {
            var response: [String: Any] = ["id": NSNull()]
            do {
                guard let data = line.data(using: .utf8), data.count <= 1048576,
                      let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = integer(input["id"]), let method = input["method"] as? String else {
                    throw BridgeError.code("NATIVE_ERROR")
                }
                response["id"] = id
                let result: [String: Any]
                switch method {
                case "hello": result = try session.hello()
                case "observe": result = try session.observe()
                case "press", "setValue": result = try session.act(method, input)
                default: throw BridgeError.code("UNSUPPORTED")
                }
                response["result"] = result
            } catch BridgeError.code(let code) { response["error"] = ["code": code] }
              catch { response["error"] = ["code": "NATIVE_ERROR"] }
            guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]), data.count <= 1048576,
                  let text = String(data: data, encoding: .utf8) else { return }
            print(text); fflush(stdout)
        }
    }
}
