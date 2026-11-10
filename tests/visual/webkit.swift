// Native macOS WebKit, the rendering engine used by Tauri on this platform.
import AppKit
import WebKit

let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let label = CommandLine.arguments[3]
let application = NSApplication.shared
application.setActivationPolicy(.regular)

class LayoutHarness: NSObject, WKNavigationDelegate {
    var window: NSWindow!
    var webview: WKWebView!
    var viewports: [[Int]] = []
    var viewportIndex = 0
    var report: [String: Any] = [:]
    let scenes = ["empty", "launch", "card"]

    func start() throws {
        let data = try Data(contentsOf: output.appendingPathComponent("reference.json"))
        let settings = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        viewports = settings["viewports"] as! [[Int]]
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let mock = try String(contentsOf: output.appendingPathComponent("mock.js"), encoding: .utf8)
        config.userContentController.addUserScript(WKUserScript(source: mock, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 720), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        webview = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webview.autoresizingMask = [.width, .height]
        webview.navigationDelegate = self
        window.contentView = webview
        window.makeKeyAndOrderFront(nil)
        application.activate(ignoringOtherApps: true)
        loadViewport()
    }

    func loadViewport() {
        let size = viewports[viewportIndex]
        window.setContentSize(NSSize(width: size[0], height: size[1]))
        webview.loadFileURL(source.appendingPathComponent("src/index.html"), allowingReadAccessTo: source)
    }

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        do {
            let probe = try String(contentsOf: output.appendingPathComponent("probe.js"), encoding: .utf8)
            webview.evaluateJavaScript(probe) { _, error in
                if let error = error { self.fail(error); return }
                self.capture(0)
            }
        } catch { fail(error) }
    }

    func capture(_ index: Int) {
        if index == scenes.count {
            viewportIndex += 1
            if viewportIndex < viewports.count { loadViewport(); return }
            do {
                let data = try JSONSerialization.data(withJSONObject: ["engine": "WKWebView", "scenes": report], options: [.prettyPrinted, .sortedKeys])
                try data.write(to: output.appendingPathComponent("\(label).json"))
                exit(0)
            } catch { fail(error) }
            return
        }
        let size = viewports[viewportIndex]
        let scene = scenes[index]
        let key = "\(size[0])x\(size[1])-\(scene)"
        webview.callAsyncJavaScript("return await window.captureLayout(scene)", arguments: ["scene": scene], in: nil, in: .page) { result in
            switch result {
            case .failure(let error): self.fail(error)
            case .success(let value):
                self.report[key] = value
                self.webview.takeSnapshot(with: nil) { image, error in
                    if let error = error { self.fail(error); return }
                    guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
                    do { try png.write(to: output.appendingPathComponent("\(label)-\(key).png")) }
                    catch { self.fail(error); return }
                    self.capture(index + 1)
                }
            }
        }
    }

    func fail(_ error: Error) { fputs("\(error)\n", stderr); exit(1) }
}

let harness = LayoutHarness()
do { try harness.start() } catch { fputs("\(error)\n", stderr); exit(1) }
DispatchQueue.main.asyncAfter(deadline: .now() + 45) { fputs("Layout capture timed out.\n", stderr); exit(1) }
application.run()
