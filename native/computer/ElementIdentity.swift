import ApplicationServices

/// Identities are observation bookkeeping, never action handles.
final class ElementIdentityRegistry {
    private struct Entry {
        let element: AXUIElement
        let fingerprint: [String]
        let parent: String?
        let identity: String
    }
    private var window: AXUIElement?
    private var committed: [CFHashCode: [Entry]] = [:]
    private var current: [CFHashCode: [Entry]] = [:]
    private var nextIdentity = 1

    func begin(window: AXUIElement, subtree: Bool = false) {
        if subtree || self.window == nil || !CFEqual(self.window!, window) { committed.removeAll() }
        self.window = window
        current.removeAll()
    }

    func identify(_ element: AXUIElement, fingerprint: [String], parent: String?) -> String {
        let hash = CFHash(element)
        let matches = (committed[hash] ?? []).filter {
            CFEqual($0.element, element) && $0.fingerprint == fingerprint && $0.parent == parent
        }
        let identity: String
        if matches.count == 1 { identity = matches[0].identity }
        else { identity = "n\(nextIdentity)"; nextIdentity += 1 }
        current[hash, default: []].append(Entry(element: element, fingerprint: fingerprint, parent: parent, identity: identity))
        return identity
    }

    func finish(complete: Bool) {
        committed = complete ? current : [:]
        current.removeAll()
        if !complete { window = nil }
    }
}

func testElementIdentities() {
    // Construct opaque handles only: no AX attribute reads, actions or GUI access.
    let a = AXUIElementCreateApplication(1)
    let sameA = AXUIElementCreateApplication(1)
    let b = AXUIElementCreateApplication(2)
    let window = AXUIElementCreateApplication(3)
    let registry = ElementIdentityRegistry()
    registry.begin(window: window)
    let first = registry.identify(a, fingerprint: ["same label"], parent: nil)
    let second = registry.identify(b, fingerprint: ["same label"], parent: nil)
    precondition(first != second)
    registry.finish(complete: true)
    registry.begin(window: window)
    precondition(registry.identify(b, fingerprint: ["same label"], parent: nil) == second)
    precondition(registry.identify(sameA, fingerprint: ["same label"], parent: nil) == first)
    registry.finish(complete: true)
    registry.begin(window: window)
    let reused = registry.identify(a, fingerprint: ["new value"], parent: nil)
    precondition(reused != first)
    registry.finish(complete: true)
    registry.begin(window: window)
    precondition(registry.identify(a, fingerprint: ["new value"], parent: second) != reused)
    registry.finish(complete: false)
    registry.begin(window: window)
    let afterIncomplete = registry.identify(a, fingerprint: ["new value"], parent: nil)
    precondition(afterIncomplete != reused)
    registry.finish(complete: true)
    registry.begin(window: b)
    let afterWindow = registry.identify(a, fingerprint: ["new value"], parent: nil)
    precondition(afterWindow != afterIncomplete)
    registry.finish(complete: true)
    registry.begin(window: b, subtree: true)
    precondition(registry.identify(a, fingerprint: ["new value"], parent: nil) != afterWindow)
    registry.finish(complete: false)
}
