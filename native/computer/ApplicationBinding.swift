import Foundation
import Darwin

enum ApplicationBindingFailure: String, Error {
    case unavailable = "Cannot read a complete, stable target process identity. Bind it again."
    case changed = "The target PID, kernel birth identity or executable changed. Bind it again."
    case terminated = "The pinned target process terminated. Bind it again."
    case invalidated = "The target binding is invalid. Bind it again."
}

// Discovery/activation objects are metadata, not proof of process identity.
// Generic so the production policy is exercised without AppKit or GUI access.
struct RegisteredApplication<Application> {
    let application: Application
    let pid: pid_t
    let terminated: Bool
}

final class ApplicationBinding<Application> {
    let application: Application
    let identity: ProcessIdentity
    private(set) var isValid = true

    init(application: Application, pid: pid_t, executable: String?, sample: ProcessIdentitySample) throws {
        guard let identity = sample.identity, identity.isComplete,
              let executable, executable.hasPrefix("/") else { throw ApplicationBindingFailure.unavailable }
        guard sample.pid == pid, identity.pid == pid, identity.executable == executable else {
            throw ApplicationBindingFailure.changed
        }
        self.application = application
        self.identity = identity
    }

    func validatedApplication(sample: ProcessIdentitySample, pinnedTerminated: Bool,
                              registered: RegisteredApplication<Application>?) throws -> Application {
        guard isValid else { throw ApplicationBindingFailure.invalidated }
        do {
            guard let current = sample.identity, current.isComplete else { throw ApplicationBindingFailure.unavailable }
            guard sample.pid == identity.pid, current == identity else { throw ApplicationBindingFailure.changed }
            guard !pinnedTerminated, registered?.terminated != true else { throw ApplicationBindingFailure.terminated }
            if let registered {
                guard registered.pid == identity.pid else { throw ApplicationBindingFailure.changed }
                return registered.application
            }
            // A registry miss cannot negate a freshly proved exact identity.
            return application
        } catch {
            isValid = false // No recovery on a later good sample; require a new binding.
            throw error
        }
    }
}

// Exercise the production policy with opaque discovery objects, without AppKit.
func testApplicationBinding(_ group: String? = nil) {
    let identity = ProcessIdentity(pid: 42, startSeconds: 100, startMicroseconds: 123, executable: "/test/app")
    func sample(_ current: ProcessIdentity?) -> ProcessIdentitySample {
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        return ProcessIdentitySample(pid: current?.pid ?? identity.pid, bsdBytes: current == nil ? 0 : size,
            bsdErrno: 0, pathBytes: current == nil ? 0 : 9, pathErrno: 0, verifyBytes: current == nil ? 0 : size,
            verifyErrno: 0, verifyPathBytes: current == nil ? 0 : 9, verifyPathErrno: 0,
            status: current == nil ? nil : 2, identity: current)
    }
    func bind() -> ApplicationBinding<String> {
        try! ApplicationBinding(application: "pinned metadata/object", pid: identity.pid,
            executable: identity.executable, sample: sample(identity))
    }
    func expect(_ expected: ApplicationBindingFailure, _ run: () throws -> Void) {
        do { try run(); preconditionFailure("Binding must refuse: \(expected)") }
        catch let error as ApplicationBindingFailure { precondition(error == expected) }
        catch { preconditionFailure("Unexpected binding error: \(error)") }
    }
    func rejects(_ expected: ApplicationBindingFailure, current: ProcessIdentity?, pinnedTerminated: Bool = false,
                 registered: RegisteredApplication<String>? = nil) {
        let binding = bind()
        expect(expected) { _ = try binding.validatedApplication(sample: sample(current), pinnedTerminated: pinnedTerminated, registered: registered) }
        precondition(!binding.isValid)
        // A later exact match must not resurrect a binding or old snapshots.
        expect(.invalidated) { _ = try binding.validatedApplication(sample: sample(identity), pinnedTerminated: false, registered: nil) }
    }
    if group == nil || group == "bind" {
        expect(.unavailable) { _ = try ApplicationBinding(application: "app", pid: identity.pid, executable: identity.executable, sample: sample(nil)) }
        for executable in [nil, "relative"] as [String?] {
            expect(.unavailable) { _ = try ApplicationBinding(application: "app", pid: identity.pid, executable: executable, sample: sample(identity)) }
        }
        expect(.changed) { _ = try ApplicationBinding(application: "app", pid: identity.pid, executable: "/different/app", sample: sample(identity)) }
        expect(.changed) { _ = try ApplicationBinding(application: "app", pid: identity.pid + 1, executable: identity.executable, sample: sample(identity)) }
        for incomplete in [
            ProcessIdentity(pid: 0, startSeconds: 100, startMicroseconds: 123, executable: identity.executable),
            ProcessIdentity(pid: 42, startSeconds: 0, startMicroseconds: 123, executable: identity.executable),
            ProcessIdentity(pid: 42, startSeconds: 100, startMicroseconds: 1_000_000, executable: identity.executable),
            ProcessIdentity(pid: 42, startSeconds: 100, startMicroseconds: 123, executable: "relative")
        ] { expect(.unavailable) { _ = try ApplicationBinding(application: "app", pid: incomplete.pid, executable: identity.executable, sample: sample(incomplete)) } }
    }
    if group == nil || group == "metadata" {
        let binding = bind()
        // quiet-native-02: registry absent, pinned alive, kernel birth/image match.
        precondition(try! binding.validatedApplication(sample: sample(identity), pinnedTerminated: false, registered: nil) == binding.application)
        let live = RegisteredApplication(application: "fresh metadata/object", pid: identity.pid, terminated: false)
        precondition(try! binding.validatedApplication(sample: sample(identity), pinnedTerminated: false, registered: live) == live.application)
        precondition(binding.isValid)
        rejects(.changed, current: identity, registered: RegisteredApplication(application: "wrong target", pid: identity.pid + 1, terminated: false))
    }
    if group == nil || group == "changes" {
        for changed in [
            ProcessIdentity(pid: identity.pid + 1, startSeconds: identity.startSeconds, startMicroseconds: identity.startMicroseconds, executable: identity.executable),
            ProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds + 1, startMicroseconds: identity.startMicroseconds, executable: identity.executable),
            ProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds, startMicroseconds: identity.startMicroseconds + 1, executable: identity.executable),
            ProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds, startMicroseconds: identity.startMicroseconds, executable: identity.executable + ".other")
        ] {
            rejects(.changed, current: changed)
            rejects(.changed, current: changed, registered: RegisteredApplication(application: "registered", pid: changed.pid, terminated: false))
        }
    }
    if group == nil || group == "unavailable" {
        rejects(.unavailable, current: nil)
        rejects(.unavailable, current: nil, registered: RegisteredApplication(application: "registered", pid: identity.pid, terminated: false))
    }
    if group == nil || group == "terminated" {
        rejects(.terminated, current: identity, pinnedTerminated: true)
        rejects(.terminated, current: identity, registered: RegisteredApplication(application: "registered", pid: identity.pid, terminated: true))
    }
}
