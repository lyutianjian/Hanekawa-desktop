// Independent public-API reproduction starter, authored for this report.
// This is not recovered OpenAI source and does not connect to Codex services.
// macOS 14.4+: swiftc -parse-as-library mac-ax-bridge.swift -o mac-ax-bridge
import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit

enum BridgeError: Error, CustomStringConvertible {
    case invalid(String)
    var description: String { if case .invalid(let message) = self { return message }; return "bridge error" }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
    if CFGetTypeID(value) == CFNumberGetTypeID() { return String(describing: value) }
    return nil
}
func integer(_ value: Any?) -> Int? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    let number = value.doubleValue
    guard number.isFinite, number.rounded() == number, number >= 0, number < Double(Int.max) else { return nil }
    return Int(number)
}

@MainActor
final class AppSession {
    let bundleID: String
    let outputDirectory: URL
    var revision = 0
    var elements: [AXUIElement] = []
    var snapshotPID: pid_t?

    init(bundleID: String, outputDirectory: URL) {
        self.bundleID = bundleID
        self.outputDirectory = outputDirectory
    }

    func runningApp() throws -> NSRunningApplication {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard apps.count == 1, let app = apps.first else {
            throw BridgeError.invalid("Target must already be running as one unambiguous process")
        }
        return app
    }

    func observe() throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw BridgeError.invalid("Accessibility permission is required") }
        let app = try runningApp()
        let root = AXUIElementCreateApplication(app.processIdentifier)
        elements.removeAll()
        revision += 1
        snapshotPID = app.processIdentifier
        var nodes: [[String: Any]] = []
        var lines: [String] = []
        var truncated = false
        let start = Date()
        func walk(_ element: AXUIElement, depth: Int) {
            guard depth <= 24, elements.count < 1000, Date().timeIntervalSince(start) < 3 else {
                truncated = true; return
            }
            let index = elements.count
            elements.append(element)
            var node: [String: Any] = ["id": index, "depth": depth]
            for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute),
                                ("description", kAXDescriptionAttribute), ("value", kAXValueAttribute),
                                ("identifier", kAXIdentifierAttribute)] {
                if let value = stringAttribute(element, name) { node[key] = String(value.prefix(400)) }
            }
            var actions: CFArray?
            if AXUIElementCopyActionNames(element, &actions) == .success { node["actions"] = actions as? [String] ?? [] }
            nodes.append(node)
            let description = ["role", "title", "description", "value"].compactMap { node[$0] as? String }.joined(separator: " ")
            lines.append(String(repeating: "  ", count: depth) + "\(index) " + description)
            if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
                for child in children { walk(child, depth: depth + 1) }
            }
        }
        walk(root, depth: 0)
        return ["app": bundleID, "revision": revision, "text": lines.joined(separator: "\n"),
                "nodes": nodes, "truncated": truncated]
    }

    func resolve(_ input: [String: Any]) throws -> AXUIElement {
        guard integer(input["revision"]) == revision,
              let index = integer(input["index"]), elements.indices.contains(index) else {
            throw BridgeError.invalid("Stale or missing snapshot reference; observe again")
        }
        guard try runningApp().processIdentifier == snapshotPID else {
            elements.removeAll(); throw BridgeError.invalid("Target process changed; observe again")
        }
        return elements[index]
    }

    func act(_ method: String, input: [String: Any]) throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw BridgeError.invalid("Accessibility permission is required") }
        let element = try resolve(input)
        // Invalidate after every attempted action, including failures.
        defer { elements.removeAll() }
        let status: AXError
        if method == "press" {
            status = AXUIElementPerformAction(element, kAXPressAction as CFString)
        } else {
            guard let value = input["value"] as? String else { throw BridgeError.invalid("value must be a string") }
            status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        }
        guard status == .success else { throw BridgeError.invalid("AX action failed: \(status.rawValue)") }
        return ["performed": true, "observeRequired": true]
    }

    func screenshot() async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { throw BridgeError.invalid("Screen Recording permission is required") }
        let pid = try runningApp().processIdentifier
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let window = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 1 }) else {
            throw BridgeError.invalid("No capturable normal window")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = 2
        configuration.width = max(1, Int(window.frame.width) * scale)
        configuration.height = max(1, Int(window.frame.height) * scale)
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard let bytes = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw BridgeError.invalid("Could not encode PNG")
        }
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let path = outputDirectory.appendingPathComponent("window-\(UUID().uuidString).png")
        try bytes.write(to: path, options: .atomic)
        return ["file": path.path, "width": image.width, "height": image.height,
                "windowPointWidth": window.frame.width, "windowPointHeight": window.frame.height,
                "windowID": window.windowID, "requestedScale": scale]
    }
}

@main
struct Main {
    @MainActor static func main() async {
        if CommandLine.arguments.contains("--self-test") {
            precondition(integer(NSNumber(value: 1)) == 1)
            precondition(integer(NSNumber(value: 1.5)) == nil)
            precondition(integer(NSNumber(value: true)) == nil)
            print("{\"selfTest\":\"passed\",\"scope\":\"input validation only; no desktop access\"}")
            return
        }
        guard CommandLine.arguments.count == 3 else {
            fputs("Usage: mac-ax-bridge <allowed-bundle-id> <screenshot-output-directory>\n", stderr)
            return
        }
        let session = AppSession(bundleID: CommandLine.arguments[1], outputDirectory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
        // One process, one user-selected app, serial JSONL. No network listener or arbitrary code execution.
        while let line = readLine() {
            var response: [String: Any] = [:]
            do {
                guard let bytes = line.data(using: .utf8), bytes.count <= 1048576,
                      let input = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let method = input["method"] as? String else { throw BridgeError.invalid("Invalid JSON request") }
                response["id"] = input["id"] ?? NSNull()
                let result: [String: Any]
                switch method {
                case "observe": result = try session.observe()
                case "press", "setValue": result = try session.act(method, input: input)
                case "screenshot": result = try await session.screenshot()
                default: throw BridgeError.invalid("Unsupported method")
                }
                response["result"] = result
            } catch { response["error"] = String(describing: error) }
            if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
               let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
        }
    }
}
