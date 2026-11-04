import Foundation

func textSelection(_ text: String, _ selection: [String: Any]) throws -> CFRange {
    let value = text as NSString
    func boundary(_ offset: Int) -> Bool {
        offset == value.length || !(0xDC00...0xDFFF).contains(Int(value.character(at: offset)))
    }
    if let start = integer(selection["start"]), let length = integer(selection["length"]) {
        guard Set(selection.keys) == ["start", "length"], start <= value.length, length <= value.length - start,
              boundary(start), boundary(start + length) else { throw failure("INVALID_INPUT", "Selection is outside text or splits a UTF-16 surrogate pair.") }
        return CFRange(location: start, length: length)
    }
    guard let needle = selection["text"] as? String, !needle.isEmpty, needle.utf16.count <= 4096,
          Set(selection.keys).isSubset(of: ["text", "prefix", "suffix"]),
          selection["prefix"] == nil || selection["prefix"] is String,
          selection["suffix"] == nil || selection["suffix"] is String else { throw failure("INVALID_INPUT", "Invalid text selection.") }
    let prefix = selection["prefix"] as? String ?? ""
    let suffix = selection["suffix"] as? String ?? ""
    var match: NSRange?
    var offset = 0
    while offset <= value.length {
        let range = value.range(of: needle, options: .literal, range: NSRange(location: offset, length: value.length - offset))
        if range.location == NSNotFound { break }
        let end = range.location + range.length
        let validPrefix = range.location >= prefix.utf16.count && value.substring(with: NSRange(location: range.location - prefix.utf16.count, length: prefix.utf16.count)) == prefix
        let validSuffix = suffix.utf16.count <= value.length - end && value.substring(with: NSRange(location: end, length: suffix.utf16.count)) == suffix
        if validPrefix && validSuffix && boundary(range.location) && boundary(end) {
            guard match == nil else { throw failure("INVALID_INPUT", "Text appears more than once. Supply adjacent prefix/suffix or an explicit UTF-16 range.") }
            match = range
        }
        offset = range.location + 1 // Include overlapping matches when checking ambiguity.
    }
    guard let match else { throw failure("INVALID_INPUT", "No exact text match with the supplied context.") }
    return CFRange(location: match.location, length: match.length)
}

func testTextSelection() {
    func equals(_ range: CFRange?, _ start: Int, _ length: Int) -> Bool { range?.location == start && range?.length == length }
    let text = "甲😀乙 same / same尾 e\u{301}"
    precondition(equals(try? textSelection(text, ["text": "😀"]), 1, 2))
    precondition((try? textSelection(text, ["text": "same"])) == nil)
    precondition(equals(try? textSelection(text, ["text": "same", "prefix": "/ ", "suffix": "尾"]), 12, 4))
    precondition((try? textSelection("aaa", ["text": "aa"])) == nil)
    precondition((try? textSelection(text, ["start": 2, "length": 1])) == nil)
    precondition(equals(try? textSelection(text, ["start": 1, "length": 2]), 1, 2))
    precondition((try? textSelection(text, ["start": 0, "length": Int.max])) == nil)
    precondition((try? textSelection(text, ["text": "missing"])) == nil)
    precondition((try? textSelection(text, ["start": true, "length": 1])) == nil)
}
