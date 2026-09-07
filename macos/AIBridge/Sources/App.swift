// AI Browser Bridge — macOS menu-bar app.
//
// A thin status/setup shell around the bundled `ai-bridge` binary
// (Contents/MacOS/ai-bridge) and the bundled extension folder
// (Contents/Resources/extension). It:
//   • registers the bundled binary as Chrome's native messaging host on first
//     launch (only if nothing valid is registered yet — never clobbers a
//     working setup; "Set up…" forces it),
//   • starts the relay server if it is not running,
//   • polls `ai-bridge ping` and shows Connected / Server down / Extension not
//     connected in the menu bar,
//   • opens the Chrome Web Store page (or, until the extension is published,
//     chrome://extensions plus the bundled extension folder for Load unpacked),
//   • copies the CLI path / CLAUDE.md snippet, opens the log, toggles Start at
//     login (SMAppService), quits.
// No Node.js on the user's machine is required; the binary is self-contained.

import Cocoa
import ServiceManagement

enum BridgeState { case connected, serverDown, extensionMissing, noToken, unknown(String) }

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var state: BridgeState = .unknown("starting")
    private let stateItem = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Start at login", action: #selector(toggleLogin), keyEquivalent: "")

    // Bundled pieces
    private var binURL: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ai-bridge") }
    private var extensionDir: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/extension") }
    private var stateDir: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ai-browser-bridge") }
    private var logURL: URL { stateDir.appendingPathComponent("bridge.log") }
    private var hostManifest: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ai_bridge.host.json")
    }
    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Bundle.main.bundleURL.path.hasPrefix("/Volumes/") {
            alert("Move AI Browser Bridge to Applications first",
                  "You are running it from the disk image. Drag the app to Applications, eject the image, then open it from there — the native host must point at a permanent location.")
            NSApp.terminate(nil); return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = symbol("point.3.connected.trianglepath.dotted")
        statusItem.menu = buildMenu()
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off

        ensureRegistered(force: false)
        ensureServer()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // MARK: menu

    private func buildMenu() -> NSMenu {
        let m = NSMenu()
        stateItem.isEnabled = false
        m.addItem(stateItem)
        m.addItem(NSMenuItem.separator())
        m.addItem(item("Add to Chrome…", #selector(addToChrome)))
        m.addItem(item("Open Extension Options", #selector(openOptions)))
        m.addItem(item("Set up native host again", #selector(setupAgain)))
        m.addItem(NSMenuItem.separator())
        m.addItem(item("Copy CLI path", #selector(copyCLI)))
        m.addItem(item("Copy CLAUDE.md snippet", #selector(copySnippet)))
        m.addItem(item("Open log", #selector(openLog)))
        m.addItem(NSMenuItem.separator())
        m.addItem(loginItem)
        let about = NSMenuItem(title: "AI Browser Bridge \(version)", action: nil, keyEquivalent: "")
        about.isEnabled = false
        m.addItem(about)
        m.addItem(item("Quit", #selector(quit), key: "q"))
        m.items.forEach { $0.target = self }
        return m
    }

    private func item(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: key); i.target = self; return i
    }

    private func symbol(_ name: String) -> NSImage? {
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "AI Browser Bridge")
        img?.isTemplate = true
        return img
    }

    // MARK: state

    private func refresh() {
        let r = run(["ping"])
        if r.status == 0 && r.out.contains("\"pong\":true") { state = .connected }
        else if r.err.contains("connect failed") { state = .serverDown }
        else if r.err.contains("extension not connected") { state = .extensionMissing }
        else if r.err.contains("no token") { state = .noToken }
        else { state = .unknown(r.err.trimmingCharacters(in: .whitespacesAndNewlines)) }

        switch state {
        case .connected:
            stateItem.title = "● Connected — server and extension are up"
            statusItem.button?.image = symbol("point.3.connected.trianglepath.dotted")
        case .serverDown:
            stateItem.title = "○ Server not running — starting…"
            statusItem.button?.image = symbol("point.3.filled.connected.trianglepath.dotted")
            ensureServer()
        case .extensionMissing:
            stateItem.title = "◐ Server up, extension not connected — use Add to Chrome…"
            statusItem.button?.image = symbol("point.3.filled.connected.trianglepath.dotted")
        case .noToken:
            stateItem.title = "○ Not set up yet — starting server…"
            ensureServer()
        case .unknown(let msg):
            stateItem.title = "? " + (msg.isEmpty ? "unknown state" : String(msg.prefix(70)))
        }
    }

    /// Start the relay server detached if nothing listens on the port.
    private func ensureServer() {
        let r = run(["ping"])
        guard r.err.contains("connect failed") || r.err.contains("no token") else { return }
        let p = Process()
        p.executableURL = binURL
        p.arguments = ["serve"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()   // not waited on; outlives this app
    }

    /// Register the bundled binary as the native messaging host. With force ==
    /// false only when nothing is registered or the registered path is gone.
    private func ensureRegistered(force: Bool) {
        if !force, let data = try? Data(contentsOf: hostManifest),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = obj["path"] as? String, FileManager.default.isExecutableFile(atPath: path) {
            return // a working host is registered (maybe a source install) — leave it
        }
        let r = run(["register-host"])
        if r.status != 0 { alert("Could not register the native host", r.err) }
    }

    // MARK: actions

    @objc private func addToChrome() {
        if let store = Config.storeURL, let url = URL(string: store) {
            NSWorkspace.shared.open(url); return
        }
        // Not on the Web Store yet: guide through Load unpacked.
        NSWorkspace.shared.activateFileViewerSelecting([extensionDir])
        openInChrome("chrome://extensions")
        alert("Load the extension in Chrome",
              "1. In the chrome://extensions tab that just opened, turn on Developer mode (top right).\n" +
              "2. Click “Load unpacked” and choose the “extension” folder that Finder is showing.\n" +
              "3. On the new card click Details and turn on “Allow User Scripts”.\n\n" +
              "The extension fetches its token by itself; this menu turns to Connected within a few seconds.")
    }

    @objc private func openOptions() { openInChrome("chrome-extension://\(Config.extensionID)/options.html") }

    @objc private func setupAgain() {
        ensureRegistered(force: true)
        ensureServer()
        alert("Native host registered", "Chrome, Brave, Edge and Arc (where installed) now launch\n\(binURL.path)\nas the AI Browser Bridge host. Reload the extension once if it is already installed.")
        refresh()
    }

    @objc private func copyCLI() { copy(binURL.path) }

    @objc private func copySnippet() {
        copy("""
        ## Browser control (AI Browser Bridge)

        A local bridge to my real, logged-in Chrome is available. Run commands as:

            \(binURL.path) <cmd> [params-json] [--file js] [--out file] [--timeout ms]

        For multi-step browser tasks delegate to the built-in agent instead of driving command-by-command:

            \(binURL.path) agent "task description" [--timeout ms] [--verbose]

        Always `ping` first. Commands: ping, listTabs, newTab '{"url":"…"}' (background tab), navigate, eval '{"tabId":N,"code":"…"}', click, insertText, type, key, waitFor, scroll, screenshot --out f.png, pdf --out f.pdf (--debugger), download, selectTab, closeTab, detach, detachAll, status. Add --debugger only when a site needs trusted input, pdf, or background-tab screenshots. Never log out or submit destructive forms without asking me.
        """)
    }

    @objc private func openLog() {
        if !FileManager.default.fileExists(atPath: logURL.path) { alert("No log yet", "The log appears at \(logURL.path) after the first command.") ; return }
        NSWorkspace.shared.open(logURL)
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch { alert("Could not change login item", error.localizedDescription) }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: helpers

    private func openInChrome(_ url: String) {
        // chrome:// and chrome-extension:// URLs are not openable via NSWorkspace; hand them to Chrome directly.
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-a", "Google Chrome", url]
        try? p.run()
    }

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert(); a.messageText = title; a.informativeText = text
        NSApp.activate(ignoringOtherApps: true); a.runModal()
    }

    private struct Result { let status: Int32; let out: String; let err: String }
    private func run(_ args: [String]) -> Result {
        let p = Process(); p.executableURL = binURL; p.arguments = args
        let o = Pipe(), e = Pipe(); p.standardOutput = o; p.standardError = e; p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return Result(status: -1, out: "", err: error.localizedDescription) }
        let out = String(data: o.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: e.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        p.waitUntilExit()
        return Result(status: p.terminationStatus, out: out, err: err)
    }
}

@main
struct AIBridgeApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
        app.run()
    }
}
