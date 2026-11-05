import AppKit
import Darwin

// Disposable read-only probe. Accept only the driver's owned fixture image.
// There is no AX, window enumeration, event tap or input in this process.
@main struct ProcessSample {
    static func main() throws {
        guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]), pid > 0,
              CommandLine.arguments[2].hasPrefix("/"),
              CommandLine.arguments[2].hasSuffix("Hanekawa Computer Fixture.app/Contents/MacOS/ComputerFixture") else { exit(64) }
        // The driver already supplies its realpath-resolved absolute image path.
        // Foundation standardization rewrites existing /private paths to aliases,
        // unlike proc_pidpath. Preserve the exact expected kernel spelling.
        let expected = CommandLine.arguments[2]
        let sample = sampleProcessIdentity(pid)
        var facts = sample.diagnostics()
        facts["sampledAt"] = Date().timeIntervalSince1970 * 1000
        facts["executableMatch"] = sample.identity?.executable == expected
        if sample.identity?.executable == expected {
            let app = NSRunningApplication(processIdentifier: pid)
            facts["appKitRegistered"] = app != nil
            if let app {
                facts["appKitTerminated"] = app.isTerminated
                if let date = app.launchDate { facts["appKitLaunchMilliseconds"] = date.timeIntervalSince1970 * 1000 }
            }
        }
        let data = try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
    }
}
