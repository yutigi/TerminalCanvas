// Native macOS WebKit, the rendering engine used by Tauri on this platform.
import AppKit
import WebKit

let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let label = CommandLine.arguments[3]
let application = NSApplication.shared
application.setActivationPolicy(.regular)

// The fixture must retain its requested viewport even on a small CI display.
class FixtureWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

class LayoutHarness: NSObject, WKNavigationDelegate {
    var window: NSWindow!
    var webview: WKWebView!
    var viewports: [[Int]] = []
    var viewportIndex = 0
    var report: [String: Any] = [:]
    var negativeArrowFill: [String: Any] = [:]
    var scenes: [String] = []
    var verifyRegression = false

    func start() throws {
        let data = try Data(contentsOf: output.appendingPathComponent("reference.json"))
        let settings = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        viewports = settings["viewports"] as! [[Int]]
        scenes = settings["scenes"] as! [String]
        verifyRegression = settings["verifyRegression"] as? Bool ?? false
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let mock = try String(contentsOf: output.appendingPathComponent("mock.js"), encoding: .utf8)
        config.userContentController.addUserScript(WKUserScript(source: mock, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        window = FixtureWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 720), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
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
                let data = try JSONSerialization.data(withJSONObject: ["engine": "WKWebView", "scenes": report, "negativeArrowFill": negativeArrowFill], options: [.prettyPrinted, .sortedKeys])
                try data.write(to: output.appendingPathComponent("\(label).json"))
                exit(0)
            } catch { fail(error) }
            return
        }
        let size = viewports[viewportIndex]
        let scene = scenes[index]
        let key = "\(size[0])x\(size[1])-\(scene)"
        captureScene(scene, key: key) { metrics in
            self.report[key] = metrics
            if scene == "board" && self.verifyRegression && label == "webkit" {
                self.webview.evaluateJavaScript("window.layoutArrowFillFault(true)") { _, error in
                    if let error = error { self.fail(error); return }
                    self.captureScene(scene, key: "missing-fill-\(key)") { broken in
                        self.negativeArrowFill[key] = broken
                        self.webview.evaluateJavaScript("window.layoutArrowFillFault(false)") { _, error in
                            if let error = error { self.fail(error); return }
                            self.capture(index + 1)
                        }
                    }
                }
            } else {
                self.capture(index + 1)
            }
        }
    }

    func captureScene(_ scene: String, key: String, completion: @escaping ([String: Any]) -> Void) {
        let size = viewports[viewportIndex]
        webview.callAsyncJavaScript("await window.waitForLayoutViewport(width, height); return await window.captureLayout(scene)",
            arguments: ["scene": scene, "width": size[0], "height": size[1]], in: nil, in: .page) { result in
            switch result {
            case .failure(let error): self.fail(error)
            case .success(let value):
                guard var metrics = value as? [String: Any] else { exit(1) }
                self.webview.takeSnapshot(with: nil) { image, error in
                    if let error = error { self.fail(error); return }
                    guard let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
                    do { try png.write(to: output.appendingPathComponent("\(label)-\(key).png")) }
                    catch { self.fail(error); return }
                    let dataURL = "data:image/png;base64," + png.base64EncodedString()
                    self.webview.callAsyncJavaScript("return await window.sampleLayoutPixels(dataURL, lines)",
                        arguments: ["dataURL": dataURL, "lines": metrics["lines"] ?? []], in: nil, in: .page) { result in
                        switch result {
                        case .failure(let error): self.fail(error)
                        case .success(let pixels):
                            metrics["pixels"] = pixels
                            completion(metrics)
                        }
                    }
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
