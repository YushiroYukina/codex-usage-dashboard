import Cocoa
import WebKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var output = Data()
    var allowedOrigin: URL?
    var statusItem: NSStatusItem?
    var stopping = false
    var noticeTimer: Timer?
    var noticesReady = false
    var seenNotices = Set<String>()
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: "显示Codex 用量看板", action: #selector(showWindow), keyEquivalent: "0").target = self
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "退出Codex 用量看板", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength); statusItem?.button?.title = "▥"
        let tray = NSMenu(); tray.addItem(withTitle: "显示Codex 用量看板", action: #selector(showWindow), keyEquivalent: "").target = self
        tray.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""); statusItem?.menu = tray
        let config = WKWebViewConfiguration(); config.userContentController.add(self, name: "ledger")
        web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 850), styleMask: [.titled,.closable,.miniaturizable,.resizable], backing: .buffered, defer: false)
        window.title = "Codex 用量看板 · 0.5.0-rc.2"; window.minSize = NSSize(width: 640, height: 560); window.contentView = web; window.isReleasedWhenClosed = false; window.center(); showWindow()
        UNUserNotificationCenter.current().delegate = self
        do {
            guard let url = Bundle.main.url(forResource: "launcher", withExtension: "json"), let launch = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String:String], let node = launch["nodePath"], let script = launch["serverPath"], let installation = launch["configPath"] else { throw NSError(domain:"UsageLedger",code:1) }
            let process = Process(); process.executableURL = URL(fileURLWithPath: node); process.arguments = [script,installation,"--native","--parent-pid",String(ProcessInfo.processInfo.processIdentifier)]
            var environment = ProcessInfo.processInfo.environment
            environment["NODE_USE_ENV_PROXY"] = "1"
            environment["no_proxy"] = (environment["no_proxy"] ?? environment["NO_PROXY"] ?? "") + ",127.0.0.1,localhost,::1"
            process.environment = environment
            let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let bytes = handle.availableData
                guard !bytes.isEmpty else { handle.readabilityHandler = nil; return }
                DispatchQueue.main.async {
                    guard let self = self else { return }; self.output.append(bytes)
                    if let end = self.output.firstIndex(of: 10) {
                        let line = self.output.prefix(upTo: end); self.output.removeSubrange(...end)
                        if let object = try? JSONSerialization.jsonObject(with: line) as? [String:String], let text = object["url"], let address = URL(string:text), address.scheme == "http", address.host == "127.0.0.1" {
                            self.allowedOrigin = address; self.web.load(URLRequest(url: address))
                            self.noticeTimer?.invalidate(); self.noticeTimer = Timer.scheduledTimer(withTimeInterval:2,repeats:true) { [weak self] _ in self?.pollNotices() }
                        }
                    }
                }
            }
            process.terminationHandler = { [weak self] _ in DispatchQueue.main.async { if self?.stopping == false { self?.web.loadHTMLString("<p>Codex 用量看板已退出。重新打开应用即可启动。</p>", baseURL:nil) } } }
            server = process; try process.run()
        } catch { let alert = NSAlert(); alert.messageText = "无法启动本地服务"; alert.informativeText = "请确认 Node.js 路径有效，并重新运行安装器。"; alert.runModal() }
    }
    @objc func showWindow() { window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true) }
    func applicationShouldHandleReopen(_ sender:NSApplication, hasVisibleWindows flag:Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification:Notification) { stopping = true; noticeTimer?.invalidate(); if server?.isRunning == true { server?.terminate() } }
    func pollNotices() {
        guard let origin = allowedOrigin, let token = origin.fragment, let url = URL(string:"/api/live",relativeTo:origin)?.absoluteURL else { return }
        var request = URLRequest(url:url); request.setValue(token,forHTTPHeaderField:"X-Ledger-Token")
        URLSession.shared.dataTask(with:request) { [weak self] data,_,_ in
            guard let data = data, let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any], let notices = object["notices"] as? [[String:Any]] else { return }
            DispatchQueue.main.async {
                guard let self = self else { return }
                for n in notices {
                    guard let id = n["id"] as? String else { continue }
                    let first = self.seenNotices.insert(id).inserted
                    guard first, self.noticesReady, UserDefaults.standard.bool(forKey:"completionNotifications"), let ended = n["endedAt"] as? Double, Date().timeIntervalSince1970*1000-ended < 60000 else { continue }
                    let usage = n["usage"] as? [String:Any]; let value = (usage?["total"] as? NSNumber)?.doubleValue ?? 0
                    let tokens = value >= 1e8 ? String(format:"%.2f亿",value/1e8) : value >= 1e4 ? String(format:"%.2f万",value/1e4) : String(format:"%.0f",value)
                    let weekly = n["weekly"] as? [String:Any]; let points = (weekly?["observedPoints"] as? NSNumber).map { String(format:"%.2f%%*",$0.doubleValue) } ?? "待核实"
                    let content = UNMutableNotificationContent(); content.title = "本轮已完成"; content.body = "Token \(tokens) · 周额 \(points)"
                    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier:id,content:content,trigger:nil))
                }
                self.noticesReady = true
            }
        }.resume()
    }
    func webView(_ webView:WKWebView, decidePolicyFor navigationAction:WKNavigationAction, decisionHandler:@escaping (WKNavigationActionPolicy)->Void) {
        guard let url = navigationAction.request.url, let origin = allowedOrigin, url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { decisionHandler(.cancel); return }; decisionHandler(.allow)
    }
    func userContentController(_ userContentController:WKUserContentController, didReceive message:WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, let origin = allowedOrigin, url.host == origin.host, url.port == origin.port, let body = message.body as? [String:Any], let type = body["type"] as? String else { return }
        if type == "quit" { NSApp.terminate(nil) }
        if type == "openExternal", let text = body["url"] as? String, let target = URL(string:text), target.scheme == "https" || (target.scheme == "http" && ["127.0.0.1","localhost","::1"].contains(target.host ?? "")) { NSWorkspace.shared.open(target) }
        if type == "enableNotifications" { UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound]) { granted,_ in UserDefaults.standard.set(granted,forKey:"completionNotifications") } }
        if type == "notify", let title = body["title"] as? String, let text = body["body"] as? String {
            let content = UNMutableNotificationContent(); content.title = String(title.prefix(80)); content.body = String(text.prefix(300))
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier:UUID().uuidString,content:content,trigger:nil))
        }
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter, willPresent notification:UNNotification, withCompletionHandler completionHandler:@escaping (UNNotificationPresentationOptions)->Void) { completionHandler([.banner,.sound]) }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
