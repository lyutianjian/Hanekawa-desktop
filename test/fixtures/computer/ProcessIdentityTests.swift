import Foundation
import Darwin

// No AppKit import, GUI application, AX, TCC query or event dispatch.
@main struct ProcessIdentityTests {
    static func waitForIdentity(_ process: Process, executable: String) -> ProcessIdentitySample {
        for _ in 0..<200 {
            let sample = sampleProcessIdentity(process.processIdentifier)
            if sample.identity?.executable == executable { return sample }
            precondition(process.isRunning, "Owned child exited before sampling")
            Thread.sleep(forTimeInterval: 0.005)
        }
        preconditionFailure("Owned child did not expose the expected stable identity")
    }

    static func stop(_ process: Process) {
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }

    static func rejects(_ binding: ApplicationBinding<String>, sample: ProcessIdentitySample) {
        do {
            _ = try binding.validatedApplication(sample: sample, pinnedTerminated: false, registered: nil)
            preconditionFailure("Old binding must reject a dead or replaced image")
        } catch is ApplicationBindingFailure { precondition(!binding.isValid) }
        catch { preconditionFailure("Unexpected error: \(error)") }
    }

    static func lifecycle() throws {
        let executable = canonicalExecutablePath("/bin/sleep")!
        func launch() throws -> Process {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = ["30"]
            try process.run()
            return process
        }
        let first = try launch()
        defer { stop(first) }
        let baseline = waitForIdentity(first, executable: executable)
        let bound = try ApplicationBinding(application: "first", pid: first.processIdentifier, executable: executable, sample: baseline)
        let oldAfterRestart = try ApplicationBinding(application: "first", pid: first.processIdentifier, executable: executable, sample: baseline)
        let firstApplication = try bound.validatedApplication(sample: sampleProcessIdentity(first.processIdentifier), pinnedTerminated: false, registered: nil)
        precondition(firstApplication == "first")
        stop(first)
        let exited = sampleProcessIdentity(first.processIdentifier)
        precondition(exited.identity != baseline.identity)
        rejects(bound, sample: exited)
        let second = try launch()
        defer { stop(second) }
        let restarted = waitForIdentity(second, executable: executable)
        precondition(restarted.identity != baseline.identity)
        rejects(oldAfterRestart, sample: restarted)
        let fresh = try ApplicationBinding(application: "second", pid: second.processIdentifier, executable: executable, sample: restarted)
        let freshApplication = try fresh.validatedApplication(sample: restarted, pinnedTerminated: false, registered: nil)
        precondition(freshApplication == "second")
        rejects(bound, sample: baseline)
    }

    static func executableChange() throws {
        let executable = canonicalExecutablePath(CommandLine.arguments[0])!
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["--wait-exec"]
        process.standardInput = pipe
        try process.run()
        defer { stop(process) }
        let baseline = waitForIdentity(process, executable: executable)
        let bound = try ApplicationBinding(application: "before exec", pid: process.processIdentifier, executable: executable, sample: baseline)
        try pipe.fileHandleForWriting.write(contentsOf: Data([1]))
        try pipe.fileHandleForWriting.close()
        let replaced = waitForIdentity(process, executable: canonicalExecutablePath("/bin/sleep")!)
        precondition(replaced.identity!.sameStart(as: baseline.identity!))
        precondition(replaced.identity != baseline.identity)
        rejects(bound, sample: replaced)
    }

    static func main() throws {
        guard CommandLine.arguments.count == 2 else { exit(64) }
        let group = CommandLine.arguments[1]
        if group == "--wait-exec" {
            guard FileHandle.standardInput.readData(ofLength: 1) == Data([1]) else { exit(64) }
            var args = [strdup("sleep"), strdup("30"), nil]
            args.withUnsafeMutableBufferPointer { _ = execv("/bin/sleep", $0.baseAddress!) }
            exit(70)
        }
        switch group {
        case "sampling": testProcessIdentity()
        case "bind", "metadata", "changes", "unavailable", "terminated": testApplicationBinding(group)
        case "lifecycle": try lifecycle()
        case "exec": try executableChange()
        default: exit(64)
        }
        print("{\"passed\":true,\"scope\":\"no GUI access\",\"group\":\"\(group)\"}")
    }
}
