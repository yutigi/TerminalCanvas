// Materialize native formats in memory; never print or persist the user's clipboard data.
import AppKit

struct ClipboardItem: Equatable {
    var formats: [String: Data]
}

enum GuardError: Error {
    case snapshotChanged, unavailableFormat, writeFailed, restoreMismatch, accessNotAllowed, invalidCommand
}

func snapshot(_ clipboard: NSPasteboard) throws -> [ClipboardItem] {
    let generation = clipboard.changeCount
    let result = try (clipboard.pasteboardItems ?? []).map { item in
        var formats: [String: Data] = [:]
        for type in item.types {
            guard let data = item.data(forType: type) else { throw GuardError.unavailableFormat }
            formats[type.rawValue] = Data(data)
        }
        return ClipboardItem(formats: formats)
    }
    guard clipboard.changeCount == generation else { throw GuardError.snapshotChanged }
    return result
}

func restore(_ saved: [ClipboardItem], to clipboard: NSPasteboard) throws {
    let items = try saved.map { entry in
        let item = NSPasteboardItem()
        for (name, data) in entry.formats {
            guard item.setData(data, forType: NSPasteboard.PasteboardType(name)) else { throw GuardError.writeFailed }
        }
        return item
    }
    clipboard.clearContents()
    if !items.isEmpty && !clipboard.writeObjects(items) { throw GuardError.writeFailed }
    guard try snapshot(clipboard) == saved else { throw GuardError.restoreMismatch }
}

func selfTest() throws {
    let clipboard = NSPasteboard.withUniqueName()
    defer { clipboard.releaseGlobally() }
    let first = NSPasteboardItem()
    first.setString("Clipboard ไทย 工作 🚀", forType: .string)
    first.setData(Data([0, 1, 127, 255]), forType: NSPasteboard.PasteboardType("local.terminalcanvas.binary-test"))
    let second = NSPasteboardItem()
    second.setString("<p>second item</p>", forType: .html)
    guard clipboard.writeObjects([first, second]) else { throw GuardError.writeFailed }
    let saved = try snapshot(clipboard)
    guard saved.count == 2 && saved[0].formats.count == 2 else { throw GuardError.restoreMismatch }
    clipboard.clearContents()
    clipboard.setString("changed", forType: .string)
    try restore(saved, to: clipboard)
    clipboard.clearContents()
    let empty = try snapshot(clipboard)
    clipboard.setString("temporary", forType: .string)
    try restore(empty, to: clipboard)
    print("PRIVATE_CLIPBOARD_SELF_TEST_PASSED")
}

func accessAllowed(_ clipboard: NSPasteboard) -> Bool {
    if #available(macOS 15.4, *) { return clipboard.accessBehavior == .alwaysAllow }
    return true
}

func guardClipboard() throws {
    let clipboard = NSPasteboard.general
    // A new programmatic read can prompt on modern macOS. Check metadata first and
    // leave the clipboard untouched unless access is already allowed.
    guard accessAllowed(clipboard) else { throw GuardError.accessNotAllowed }
    let saved = try snapshot(clipboard)
    // Closing the parent's PTY must reach stdin EOF and restoration rather than SIGHUP.
    signal(SIGHUP, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    print("CLIPBOARD_SAVED")
    fflush(stdout)
    while let command = readLine() {
        if command == "RESTORE" { break }
        do {
            if command.hasPrefix("EXPECT_TEXT ") {
                guard let bytes = Data(base64Encoded: String(command.dropFirst(12))),
                      let text = String(data: bytes, encoding: .utf8) else { throw GuardError.invalidCommand }
                print(clipboard.string(forType: .string) == text ? "CLIPBOARD_TEXT_MATCH" : "CLIPBOARD_TEXT_MISMATCH")
            } else if command.hasPrefix("SET_TEXT ") {
                guard let bytes = Data(base64Encoded: String(command.dropFirst(9))),
                      let text = String(data: bytes, encoding: .utf8) else { throw GuardError.invalidCommand }
                clipboard.clearContents()
                guard clipboard.setString(text, forType: .string) else { throw GuardError.writeFailed }
                print("CLIPBOARD_TEST_TEXT_SET")
            } else if command.hasPrefix("SET_PNG ") {
                let bytes = try Data(contentsOf: URL(fileURLWithPath: String(command.dropFirst(8))))
                guard bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]), bytes.count <= 15 * 1024 * 1024 else {
                    throw GuardError.invalidCommand
                }
                clipboard.clearContents()
                guard clipboard.setData(bytes, forType: .png) else { throw GuardError.writeFailed }
                print("CLIPBOARD_TEST_IMAGE_SET")
            } else {
                throw GuardError.invalidCommand
            }
        } catch {
            print("CLIPBOARD_COMMAND_FAILED")
        }
        fflush(stdout)
    }
    try restore(saved, to: clipboard)
    print("CLIPBOARD_RESTORED_AND_VERIFIED")
}

do {
    switch CommandLine.arguments.dropFirst().first {
    case "--self-test": try selfTest()
    case "--access-check": print(accessAllowed(NSPasteboard.general) ? "CLIPBOARD_ACCESS_ALLOWED" : "CLIPBOARD_ACCESS_NOT_ALLOWED")
    case "--guard": try guardClipboard()
    default: throw GuardError.invalidCommand
    }
} catch {
    fputs("Clipboard guard failed: \(error)\n", stderr)
    exit(1)
}
