import AppKit

// Deliberately acknowledges AX focus writes without transferring keyboard focus.
// A successful AX setter alone must never authorize typing into this view.
final class FocusIgnoringTextView: NSTextView {
    override func setAccessibilityFocused(_ accessibilityFocused: Bool) {}
}

let secureSentinel = "FIXTURE_SECRET_DO_NOT_LOG_9X"

@MainActor final class FixtureWindow: NSObject, NSWindowDelegate, NSTableViewDataSource {
    let name: String
    let window: NSWindow
    let text = NSTextView()
    let refusesFocus = FocusIgnoringTextView()
    let password = NSSecureTextField()
    let counter = NSTextField(labelWithString: "Count: 0")
    let delayed = NSTextField(labelWithString: "Delayed: 0")
    let table = NSTableView()
    var buttons: [String: NSButton] = [:]
    var count = 0
    var delayedCount = 0
    var pendingDelay = false
    var busy = false
    var generation = 0
    var items = (0..<80).map { "item-\($0)" }
    var insertions = 0
    var sheet: NSAlert?
    var pendingSheet = false
    var sheetInput: NSTextField?
    var sheetText = ""
    var save: (() -> Void)?

    init(name: String, origin: NSPoint) {
        self.name = name
        window = NSWindow(contentRect: NSRect(origin: origin, size: NSSize(width: 660, height: 650)),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Hanekawa Computer Fixture — \(name)"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let content = window.contentView!
        counter.frame = NSRect(x: 20, y: 610, width: 250, height: 24)
        delayed.frame = NSRect(x: 300, y: 610, width: 250, height: 24)
        content.addSubview(counter)
        content.addSubview(delayed)

        let commands = [("increment", "Increment"), ("delay", "Delayed update"), ("sheet", "Show sheet"),
                        ("insert", "Insert row"), ("reverse", "Reverse rows"), ("replace", "Replace control"),
                        ("move", "Move window"), ("close", "Close window"), ("busy", "Block AX for two seconds")]
        for (index, command) in commands.enumerated() {
            addButton(command.0, title: command.1,
                      frame: NSRect(x: 20 + (index % 3) * 210, y: 567 - (index / 3) * 38, width: 200, height: 30))
        }

        let editor = NSScrollView(frame: NSRect(x: 20, y: 332, width: 620, height: 135))
        editor.hasVerticalScroller = true
        editor.borderType = .bezelBorder
        text.frame = NSRect(x: 0, y: 0, width: 600, height: 130)
        text.isRichText = false
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.setAccessibilityLabel("Editable text")
        text.setAccessibilityIdentifier("fixture-text")
        editor.documentView = text
        content.addSubview(editor)

        refusesFocus.frame = NSRect(x: 20, y: 290, width: 620, height: 28)
        refusesFocus.isRichText = false
        refusesFocus.setAccessibilityLabel("Refuses keyboard focus")
        content.addSubview(refusesFocus)

        password.frame = NSRect(x: 20, y: 255, width: 620, height: 28)
        password.stringValue = secureSentinel
        password.setAccessibilityLabel("Secure input")
        content.addSubview(password)

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("item"))
        column.width = 590
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 24
        table.dataSource = self
        table.setAccessibilityLabel("Fixture list")
        let list = NSScrollView(frame: NSRect(x: 20, y: 20, width: 620, height: 225))
        list.hasVerticalScroller = true
        list.borderType = .bezelBorder
        list.documentView = table
        content.addSubview(list)
        table.reloadData()
    }

    func addButton(_ id: String, title: String, frame: NSRect) {
        let button = NSButton(title: title, target: self, action: #selector(pressed(_:)))
        button.identifier = NSUserInterfaceItemIdentifier(id)
        button.setAccessibilityIdentifier("fixture-\(id)")
        button.frame = frame
        window.contentView!.addSubview(button)
        buttons[id] = button
    }

    @objc func pressed(_ sender: NSButton) {
        switch sender.identifier?.rawValue {
        case "increment":
            count += 1
            counter.stringValue = "Count: \(count)"
        case "delay":
            guard !pendingDelay else { return }
            pendingDelay = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { [weak self] in
                guard let self else { return }
                self.delayedCount += 1
                self.pendingDelay = false
                self.delayed.stringValue = "Delayed: \(self.delayedCount)"
                self.save?()
            }
        case "sheet":
            guard sheet == nil, !pendingSheet else { return }
            pendingSheet = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
                guard let self else { return }
                self.pendingSheet = false
                let alert = NSAlert()
                alert.messageText = "Fixture sheet"
                alert.informativeText = "This sheet belongs only to the isolated test app."
                let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 28))
                field.setAccessibilityLabel("Fixture sheet input")
                alert.accessoryView = field
                self.sheetInput = field
                alert.addButton(withTitle: "Confirm fixture sheet")
                alert.addButton(withTitle: "Dismiss fixture sheet")
                self.sheet = alert
                alert.beginSheetModal(for: self.window) { [weak self] response in
                    if response == .alertFirstButtonReturn { self?.sheetText = field.stringValue }
                    self?.sheetInput = nil
                    self?.sheet = nil
                    self?.save?()
                }
                self.save?()
            }
        case "insert":
            insertions += 1
            items.insert("inserted-\(insertions)", at: 0)
            table.reloadData()
        case "reverse":
            items.reverse()
            table.reloadData()
        case "replace":
            let old = buttons["increment"]!
            let frame = old.frame
            old.removeFromSuperview()
            generation += 1
            addButton("increment", title: "Increment", frame: frame)
        case "move":
            window.setFrameOrigin(NSPoint(x: window.frame.minX + 24, y: window.frame.minY + 16))
        case "close":
            window.performClose(nil)
        case "busy":
            busy = true
            save?()
            // A deliberate real AX stall, only inside this disposable test app.
            Thread.sleep(forTimeInterval: 2)
            busy = false
        default: return
        }
        save?()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }
    func tableView(_ tableView: NSTableView, objectValueFor tableColumn: NSTableColumn?, row: Int) -> Any? { items[row] }
    func windowWillClose(_ notification: Notification) { save?() }

    func state() -> [String: Any] {
        ["count": count, "text": text.string, "refusesFocusText": refusesFocus.string, "selection": ["start": text.selectedRange().location, "length": text.selectedRange().length], "sheetText": sheetText, "secureLength": password.stringValue.utf16.count,
         "items": items, "selectedRow": table.selectedRow, "generation": generation,
         "delayedCount": delayedCount, "pendingDelay": pendingDelay, "busy": busy,
         "sheetVisible": sheet != nil, "pendingSheet": pendingSheet, "visible": window.isVisible,
         "frame": ["x": window.frame.minX, "y": window.frame.minY, "width": window.frame.width, "height": window.frame.height],
         "controls": buttons.keys.sorted()]
    }
}

@MainActor final class FixtureApp: NSObject, NSApplicationDelegate {
    let stateURL: URL
    var panels: [FixtureWindow] = []
    var timer: Timer?
    var previous: Data?

    init(stateURL: URL) { self.stateURL = stateURL }
    func applicationDidFinishLaunching(_ notification: Notification) {
        panels = [FixtureWindow(name: "A", origin: NSPoint(x: 60, y: 80)),
                  FixtureWindow(name: "B", origin: NSPoint(x: 180, y: 120))]
        for panel in panels {
            panel.save = { [weak self] in self?.persist() }
            panel.window.orderFront(nil)
        }
        let menu = NSMenu()
        let appItem = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        let appMenu = NSMenu(title: "Fixture")
        appMenu.addItem(withTitle: "Quit fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu
        menu.addItem(edit)
        let tests = NSMenuItem(title: "Fixture tests", action: nil, keyEquivalent: "")
        let testsMenu = NSMenu(title: "Fixture tests")
        let show = NSMenuItem(title: "Show sheet in A", action: #selector(menuSheet), keyEquivalent: "")
        show.target = self
        testsMenu.addItem(show)
        tests.submenu = testsMenu
        menu.addItem(tests)
        NSApp.mainMenu = menu
        persist()
        // AXValue changes need not send delegate callbacks. Read actual controls.
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.persist() }
        }
    }
    @objc func menuSheet() { panels[0].buttons["sheet"]?.performClick(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func persist() {
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
            "bundleId": Bundle.main.bundleIdentifier ?? "", "ready": true,
            "windows": Dictionary(uniqueKeysWithValues: panels.map { ($0.name, $0.state()) })]
        do {
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            if data != previous {
                try data.write(to: stateURL, options: .atomic)
                previous = data
            }
        } catch {
            fputs("Fixture state write failed: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }
}

@main struct Main {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 2 else {
            fputs("Usage: ComputerFixture <isolated-state.json>\n", stderr)
            exit(2)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = FixtureApp(stateURL: URL(fileURLWithPath: CommandLine.arguments[1]))
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
