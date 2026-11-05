import Foundation
import Darwin

// Exact kernel birth time and image path; never use a PID-exists test as identity.
struct ProcessIdentity: Equatable {
    let pid: pid_t
    let startSeconds: UInt64
    let startMicroseconds: UInt64
    let executable: String

    var isComplete: Bool {
        pid > 0 && startSeconds > 0 && startMicroseconds < 1_000_000 && executable.hasPrefix("/")
    }

    func sameStart(as other: ProcessIdentity) -> Bool {
        pid == other.pid && startSeconds == other.startSeconds && startMicroseconds == other.startMicroseconds
    }
}

struct ProcessIdentitySample {
    let pid: pid_t
    let bsdBytes: Int32
    let bsdErrno: Int32
    let pathBytes: Int32
    let pathErrno: Int32
    let verifyBytes: Int32
    let verifyErrno: Int32
    let verifyPathBytes: Int32
    let verifyPathErrno: Int32
    let status: UInt32?
    let identity: ProcessIdentity?

    // Only numeric facts and comparisons. Image paths stay private to the binding.
    func diagnostics(comparedWith baseline: ProcessIdentity? = nil) -> [String: Any] {
        var result: [String: Any] = ["pid": pid, "bsdBytes": bsdBytes, "bsdErrno": bsdErrno,
            "pathBytes": pathBytes, "pathErrno": pathErrno, "verifyBytes": verifyBytes,
            "verifyErrno": verifyErrno, "verifyPathBytes": verifyPathBytes,
            "verifyPathErrno": verifyPathErrno, "sampleStable": identity != nil]
        if let status { result["kernelStatus"] = status }
        if let identity {
            result["kernelStartSeconds"] = String(identity.startSeconds)
            result["kernelStartMicroseconds"] = String(identity.startMicroseconds)
        }
        if let baseline {
            result["bindStartSeconds"] = String(baseline.startSeconds)
            result["bindStartMicroseconds"] = String(baseline.startMicroseconds)
            result["startMatches"] = identity?.sameStart(as: baseline) ?? false
            result["executableMatches"] = identity?.executable == baseline.executable
        }
        return result
    }
}

// Resolve AppKit's discovery URL to the kernel spelling, including /tmp and
// /var aliases. Do not standardize the resulting /private path with Foundation.
func canonicalExecutablePath(_ path: String?) -> String? {
    guard let path, path.hasPrefix("/"), let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return String(validatingCString: resolved)
}

func stableProcessIdentity(_ pid: pid_t, first: proc_bsdinfo, bsdBytes: Int32, path: String?,
                           second: proc_bsdinfo, verifyBytes: Int32, verifiedPath: String?) -> ProcessIdentity? {
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 0, bsdBytes == size, verifyBytes == size,
          first.pbi_pid == UInt32(pid), second.pbi_pid == UInt32(pid),
          first.pbi_status != 5, second.pbi_status != 5, // SZOMB: not a live image.
          first.pbi_start_tvsec > 0, first.pbi_start_tvusec < 1_000_000,
          first.pbi_start_tvsec == second.pbi_start_tvsec, first.pbi_start_tvusec == second.pbi_start_tvusec,
          let path, path.hasPrefix("/"), path == verifiedPath else { return nil }
    return ProcessIdentity(pid: pid, startSeconds: first.pbi_start_tvsec,
        startMicroseconds: first.pbi_start_tvusec, executable: path)
}

private func sampleExecutablePath(_ pid: pid_t) -> (path: String?, bytes: Int32, error: Int32) {
    // PROC_PIDPATHINFO_MAXSIZE is the public 4 * MAXPATHLEN macro.
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    errno = 0
    let bytes = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    let error = errno
    let path = bytes > 0 && bytes < buffer.count ? String(validatingCString: buffer) : nil
    return (path, bytes, error)
}

func sampleProcessIdentity(_ pid: pid_t) -> ProcessIdentitySample {
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    var first = proc_bsdinfo(), second = proc_bsdinfo()
    errno = 0
    let bsdBytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &first, size)
    let bsdErrno = errno
    let path = sampleExecutablePath(pid)
    errno = 0
    let verifyBytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &second, size)
    let verifyErrno = errno
    let verifiedPath = sampleExecutablePath(pid)
    let identity = stableProcessIdentity(pid, first: first, bsdBytes: bsdBytes, path: path.path,
        second: second, verifyBytes: verifyBytes, verifiedPath: verifiedPath.path)
    return ProcessIdentitySample(pid: pid, bsdBytes: bsdBytes, bsdErrno: bsdErrno, pathBytes: path.bytes,
        pathErrno: path.error, verifyBytes: verifyBytes, verifyErrno: verifyErrno,
        verifyPathBytes: verifiedPath.bytes, verifyPathErrno: verifiedPath.error,
        status: bsdBytes == size ? first.pbi_status : nil, identity: identity)
}

func testProcessIdentity() {
    let first = sampleProcessIdentity(getpid())
    guard let identity = first.identity, let fresh = sampleProcessIdentity(getpid()).identity else {
        preconditionFailure("Cannot sample the helper's own kernel identity")
    }
    precondition(identity == fresh)
    precondition(identity.isComplete)
    precondition(canonicalExecutablePath(identity.executable) == identity.executable)
    precondition(canonicalExecutablePath(nil) == nil && canonicalExecutablePath("relative") == nil)
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    var valid = proc_bsdinfo()
    valid.pbi_pid = UInt32(identity.pid); valid.pbi_status = 2
    valid.pbi_start_tvsec = identity.startSeconds; valid.pbi_start_tvusec = identity.startMicroseconds
    precondition(stableProcessIdentity(identity.pid, first: valid, bsdBytes: size, path: identity.executable,
        second: valid, verifyBytes: size, verifiedPath: identity.executable) == identity)
    for (firstBytes, secondBytes, firstPath, secondPath) in [
        (size - 1, size, identity.executable, identity.executable),
        (size, size - 1, identity.executable, identity.executable),
        (size, size, nil, identity.executable), (size, size, identity.executable, nil),
        (size, size, identity.executable, identity.executable + ".other"),
        (size, size, "relative", "relative")
    ] as [(Int32, Int32, String?, String?)] {
        precondition(stableProcessIdentity(identity.pid, first: valid, bsdBytes: firstBytes, path: firstPath,
            second: valid, verifyBytes: secondBytes, verifiedPath: secondPath) == nil)
    }
    var wrongPID = valid, wrongSeconds = valid, wrongMicros = valid, zombie = valid, noBirth = valid, invalidMicros = valid
    wrongPID.pbi_pid += 1; wrongSeconds.pbi_start_tvsec += 1; wrongMicros.pbi_start_tvusec += 1
    zombie.pbi_status = 5; noBirth.pbi_start_tvsec = 0; invalidMicros.pbi_start_tvusec = 1_000_000
    for changed in [wrongPID, wrongSeconds, wrongMicros, zombie, noBirth, invalidMicros] {
        precondition(stableProcessIdentity(identity.pid, first: valid, bsdBytes: size, path: identity.executable,
            second: changed, verifyBytes: size, verifiedPath: identity.executable) == nil)
        precondition(stableProcessIdentity(identity.pid, first: changed, bsdBytes: size, path: identity.executable,
            second: valid, verifyBytes: size, verifiedPath: identity.executable) == nil)
    }
    for changed in [
        ProcessIdentity(pid: identity.pid + 1, startSeconds: identity.startSeconds, startMicroseconds: identity.startMicroseconds, executable: identity.executable),
        ProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds + 1, startMicroseconds: identity.startMicroseconds, executable: identity.executable),
        ProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds, startMicroseconds: (identity.startMicroseconds + 1) % 1_000_000, executable: identity.executable),
        ProcessIdentity(pid: identity.pid, startSeconds: identity.startSeconds, startMicroseconds: identity.startMicroseconds, executable: identity.executable + ".other")
    ] { precondition(identity != changed) }
    let data = try! JSONSerialization.data(withJSONObject: first.diagnostics(comparedWith: identity), options: [.sortedKeys])
    precondition(!String(data: data, encoding: .utf8)!.contains(identity.executable))
}
