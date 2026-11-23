// StandHub.app — приложение для macOS: значок в Dock (окно с дашбордом, меню по правому клику) и в строке меню.
// Запускает сервер standhub.js (Node.js) из ресурсов приложения и следит за ним,
// показывает стенды, адрес и QR-код для iPad, управляет автозапуском при входе.
import AppKit
import CoreImage
import ServiceManagement
import WebKit

// MARK: - Модель ответа /api/state

struct HubStand: Decodable {
    let port: Int
    let name: String
    let title: String
    let framework: String
    let branch: String?
    let hidden: Bool
    let exposure: String
    let health: String
    let localUrl: String?
    let kind: String?
}

struct HubTailscale: Decodable {
    let installed: Bool
    let state: String
    let ip: String?
    let dnsName: String?
    let https: Bool
    let httpsError: String?
}

struct HubDashboard: Decodable {
    let port: Int
    let urls: [String]
}

struct HubState: Decodable {
    let version: String
    let tailscale: HubTailscale
    let bind: String?
    let dashboard: HubDashboard
    let keepAwake: Bool
    let stands: [HubStand]
}

let home = FileManager.default.homeDirectoryForCurrentUser
let configURL = home.appendingPathComponent(".config/standhub/config.json")
let logURL = home.appendingPathComponent("Library/Logs/StandHub.log")

// MARK: - Сервер (дочерний процесс node)

final class Server {
    private(set) var process: Process?
    private var stdinPipe: Pipe?
    private var stopping = false
    private var startedAt = Date()
    private var failures = 0
    var problem: String?
    var onChange: (() -> Void)?

    func start() {
        stopping = false
        guard let script = Bundle.main.path(forResource: "standhub", ofType: "js") else {
            problem = "В приложении нет standhub.js — пересобери StandHub"
            onChange?()
            return
        }
        guard let node = Server.findNode() else {
            problem = "Не найден Node.js 18+ (brew install node)"
            onChange?()
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        env["STANDHUB_EXIT_WITH_STDIN"] = "1"
        p.environment = env
        p.currentDirectoryURL = home
        let input = Pipe()
        p.standardInput = input
        if let log = Server.openLog() {
            p.standardOutput = log
            p.standardError = log
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(proc) }
        }
        do {
            try p.run()
            process = p
            stdinPipe = input
            startedAt = Date()
            problem = nil
        } catch {
            problem = "Не удалось запустить node: \(error.localizedDescription)"
        }
        onChange?()
    }

    private func exited(_ proc: Process) {
        guard proc === process || process == nil else { return }
        process = nil
        stdinPipe = nil
        if stopping { return }
        let quick = Date().timeIntervalSince(startedAt) < 5
        failures = quick ? failures + 1 : 0
        if proc.terminationStatus == 1 && quick && Server.logTail().contains("занят") {
            problem = "Порт дашборда занят — StandHub уже запущен другим способом?"
        } else {
            problem = "Сервер остановился (код \(proc.terminationStatus)), перезапускаю…"
        }
        onChange?()
        let delay = min(30.0, pow(2.0, Double(min(failures, 5))))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopping, self.process == nil else { return }
            self.start()
        }
    }

    func stop() {
        stopping = true
        guard let p = process else { return }
        p.terminate()
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
        stdinPipe = nil
    }

    func restart() {
        stop()
        failures = 0
        start()
    }

    static func openLog() -> FileHandle? {
        let fm = FileManager.default
        try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
        guard let h = try? FileHandle(forWritingTo: logURL) else { return nil }
        h.seekToEndOfFile()
        return h
    }

    static func logTail() -> String {
        guard let h = try? FileHandle(forReadingFrom: logURL) else { return "" }
        defer { try? h.close() }
        let size = h.seekToEndOfFile()
        h.seek(toFileOffset: size > 2000 ? size - 2000 : 0)
        return String(decoding: h.readDataToEndOfFile(), as: UTF8.self)
    }

    static func findNode() -> String? {
        let fm = FileManager.default
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] where fm.isExecutableFile(atPath: c) { return c }
        // node из nvm/fnm/volta — спрашиваем у login-шелла
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        let path = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return fm.isExecutableFile(atPath: path) ? path : nil
    }
}

// MARK: - Приложение

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, WKNavigationDelegate, WKUIDelegate {
    enum MenuContext { case status, main, dock }

    let server = Server()
    var statusItem: NSStatusItem?
    let statusMenu = NSMenu()
    let standsMenu = NSMenu(title: "Стенды")
    var state: HubState?
    var lastError: String?
    var timer: Timer?
    var window: NSWindow?
    var webView: WKWebView?
    var dashboardLoaded = false
    var qrWindow: NSWindow?
    var launchedAtLogin = false

    var dashPort: Int {
        if let d = try? Data(contentsOf: configURL),
           let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let p = o["dashboardPort"] as? Int { return p }
        return 7777
    }

    var base: URL { URL(string: "http://127.0.0.1:\(dashPort)/")! }

    // MARK: Жизненный цикл

    func applicationWillFinishLaunching(_ notification: Notification) {
        launchedAtLogin = AppDelegate.isLoginLaunch()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        if let other = others.first {
            other.activate()
            NSApp.terminate(nil)
            return
        }

        statusMenu.delegate = self
        statusMenu.autoenablesItems = false
        standsMenu.delegate = self
        standsMenu.autoenablesItems = false
        NSApp.mainMenu = buildMainMenu()
        updateStatusItemVisibility()
        updateButton()

        server.onChange = { [weak self] in self?.updateButton() }
        server.start()
        enableLoginItemOnFirstLaunch()

        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.poll() }

        // При автозапуске окно не показываем — только значок в Dock.
        if !launchedAtLogin { showWindow() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.autoenablesItems = false
        fillMenu(menu, context: .dock)
        return menu
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    static func isLoginLaunch() -> Bool {
        guard let ev = NSAppleEventManager.shared().currentAppleEvent,
              ev.eventID == AEEventID(kAEOpenApplication) else { return false }
        return ev.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    }

    // MARK: Окно с дашбордом

    @objc func showWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 740),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
            w.title = "StandHub"
            w.minSize = NSSize(width: 420, height: 360)
            w.isReleasedWhenClosed = false
            if !w.setFrameUsingName("StandHubMain") { w.center() }
            w.setFrameAutosaveName("StandHubMain")
            let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
            wv.navigationDelegate = self
            wv.uiDelegate = self
            w.contentView = wv
            window = w
            webView = wv
        }
        if !dashboardLoaded { loadDashboard() }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func loadDashboard() {
        webView?.load(URLRequest(url: base, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }

    @objc func reloadWindow() {
        if dashboardLoaded { webView?.reload() } else { loadDashboard() }
    }

    func isDashboard(_ url: URL?) -> Bool {
        guard let url else { return false }
        return (url.host == "127.0.0.1" || url.host == "localhost") && url.port == dashPort
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        dashboardLoaded = isDashboard(webView.url)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        dashboardLoaded = false
        let html = """
        <html><body style="font:15px -apple-system;color:#888;display:grid;place-items:center;height:90vh;margin:0">
        <div style="text-align:center"><div style="font-size:17px;color:#555;margin-bottom:6px">Запускаю сервер StandHub…</div>
        Окно обновится само.</div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" else {
            decisionHandler(.allow)
            return
        }
        if isDashboard(url) {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url) // стенды и внешние ссылки — в браузере по умолчанию
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        if let w = window { alert.beginSheetModal(for: w) { _ in completionHandler() } } else { alert.runModal(); completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Отмена")
        alert.window.initialFirstResponder = field
        let finish: (NSApplication.ModalResponse) -> Void = { r in
            completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil)
        }
        if let w = window { alert.beginSheetModal(for: w, completionHandler: finish) } else { finish(alert.runModal()) }
    }

    // MARK: Состояние

    func poll() {
        var req = URLRequest(url: base.appendingPathComponent("api/state"))
        req.timeoutInterval = 2.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, _, err in
            let decoded = data.flatMap { try? JSONDecoder().decode(HubState.self, from: $0) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.state = decoded
                self.lastError = decoded == nil ? (err?.localizedDescription ?? "нет ответа") : nil
                self.updateButton()
                if decoded != nil && !self.dashboardLoaded && self.window?.isVisible == true { self.loadDashboard() }
            }
        }.resume()
    }

    var hasProblem: Bool { server.problem != nil || state == nil || state?.bind == nil }

    func updateButton() {
        let count = state?.stands.filter { !$0.hidden && $0.kind != "service" }.count ?? 0
        NSApp.dockTile.badgeLabel = count > 0 ? "\(count)" : nil
        guard let button = statusItem?.button else { return }
        let image = NSImage(systemSymbolName: hasProblem ? "exclamationmark.triangle" : "server.rack", accessibilityDescription: "StandHub")
        image?.isTemplate = true
        button.image = image
        button.title = count > 0 ? " \(count)" : ""
        button.toolTip = "StandHub — \(statusLine())"
    }

    func updateStatusItemVisibility() {
        let show = !UserDefaults.standard.bool(forKey: "hideStatusItem")
        if show, statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.imagePosition = .imageLeading
            item.menu = statusMenu
            statusItem = item
            updateButton()
        } else if !show, let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    func statusLine() -> String {
        if let p = server.problem { return p }
        guard let s = state else { return server.process == nil ? "Сервер не запущен" : "Сервер запускается…" }
        let t = s.tailscale
        if !t.installed { return "Tailscale не установлен — стенды видны только на этом Mac" }
        if t.state != "Running" || s.bind == nil { return "Tailscale: \(t.state) — стенды видны только на этом Mac" }
        let host = (t.dnsName ?? t.ip ?? "").components(separatedBy: ".").first ?? ""
        return "Tailscale: \(host) · \(t.https ? "HTTPS" : "без HTTPS")"
    }

    var iPadURL: String? {
        guard let s = state, s.bind != nil else { return nil }
        return s.dashboard.urls.first
    }

    func iPadURL(for st: HubStand) -> String? {
        guard let s = state, s.bind != nil else { return nil }
        let t = s.tailscale
        if t.https, let dns = t.dnsName, st.exposure == "mirror" { return "https://\(dns):\(st.port)/" }
        guard let host = t.dnsName ?? t.ip else { return nil }
        return "http://\(host):\(st.port)/"
    }

    // MARK: Меню

    func buildMainMenu() -> NSMenu {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "О программе StandHub", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Скрыть StandHub", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Скрыть остальные", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Показать все", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Выйти из StandHub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(withTitle: "StandHub", action: nil, keyEquivalent: "").submenu = appMenu

        fillMenu(standsMenu, context: .main)
        main.addItem(withTitle: "Стенды", action: nil, keyEquivalent: "").submenu = standsMenu

        let edit = NSMenu(title: "Правка")
        edit.addItem(withTitle: "Отменить", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Повторить", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Вырезать", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Копировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Выбрать все", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(withTitle: "Правка", action: nil, keyEquivalent: "").submenu = edit

        let win = NSMenu(title: "Окно")
        win.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Закрыть", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(withTitle: "Окно", action: nil, keyEquivalent: "").submenu = win
        NSApp.windowsMenu = win
        return main
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === statusMenu { fillMenu(menu, context: .status) }
        if menu === standsMenu { fillMenu(menu, context: .main) }
    }

    func fillMenu(_ menu: NSMenu, context: MenuContext) {
        menu.removeAllItems()
        if context != .main { menu.addItem(sectionHeader("StandHub \(state?.version ?? "")")) }
        menu.addItem(infoItem(statusLine()))
        menu.addItem(.separator())

        if let s = state {
            let visible = s.stands.filter { !$0.hidden }
            let apps = visible.filter { $0.kind != "service" }
            let services = visible.filter { $0.kind == "service" }
            menu.addItem(sectionHeader("Стенды"))
            if apps.isEmpty { menu.addItem(infoItem(services.isEmpty ? "Нет запущенных стендов" : "Фронтендов сейчас нет")) }
            for st in apps { addStandItems(menu, st, context: context) }
            if !services.isEmpty {
                let sub = NSMenu()
                sub.autoenablesItems = false
                for st in services { addStandItems(sub, st, context: context) }
                let item = NSMenuItem(title: "Вспомогательные (\(services.count))", action: nil, keyEquivalent: "")
                item.toolTip = "Бэкенды, хранилища, админки"
                item.submenu = sub
                menu.addItem(item)
            }
            menu.addItem(.separator())
        }

        if context != .main { addItem(menu, "Открыть окно StandHub", #selector(showWindow)) }
        if context == .main {
            addItem(menu, "Показать окно", #selector(showWindow), key: "0")
            addItem(menu, "Обновить", #selector(reloadWindow), key: "r")
        }
        addItem(menu, "Открыть дашборд в браузере", #selector(openDashboard))
        let copyURL = addItem(menu, "Скопировать адрес для iPad", #selector(copyIPadURL))
        copyURL.isEnabled = iPadURL != nil
        let qr = addItem(menu, "QR-код для iPad…", #selector(showQR))
        qr.isEnabled = iPadURL != nil
        menu.addItem(.separator())

        let awake = addItem(menu, "Не давать Mac засыпать, пока есть стенды", #selector(toggleKeepAwake))
        awake.state = state?.keepAwake == true ? .on : .off
        awake.isEnabled = state != nil
        let login = addItem(menu, "Запускать при входе в систему", #selector(toggleLoginItem))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        let icon = addItem(menu, "Значок в строке меню", #selector(toggleStatusItem))
        icon.state = statusItem != nil ? .on : .off
        menu.addItem(.separator())

        addItem(menu, "Настройки (config.json)", #selector(openConfig))
        addItem(menu, "Лог", #selector(openLog))
        addItem(menu, "Перезапустить сервер", #selector(restartServer))
        if context == .status {
            menu.addItem(.separator())
            addItem(menu, "Выйти из StandHub", #selector(quit), key: "q")
        }
    }

    func addStandItems(_ menu: NSMenu, _ st: HubStand, context: MenuContext) {
        let item = addItem(menu, "", #selector(openStand(_:)))
        item.attributedTitle = standTitle(st)
        item.tag = st.port
        item.toolTip = (st.title.isEmpty ? "" : "\(st.title)\n") + "Открыть на Mac · ⌥ — скопировать ссылку для iPad"
        if context != .dock { // в меню Dock альтернативные пункты не работают
            let alt = addItem(menu, "Скопировать ссылку для iPad — \(st.name)", #selector(copyStandLink(_:)))
            alt.tag = st.port
            alt.isAlternate = true
            alt.keyEquivalentModifierMask = [.option]
        }
    }

    @discardableResult
    func addItem(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
        return item
    }

    func sectionHeader(_ title: String) -> NSMenuItem {
        if #available(macOS 14.0, *) { return NSMenuItem.sectionHeader(title: title) }
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    func infoItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    func standTitle(_ st: HubStand) -> NSAttributedString {
        let font = NSFont.menuFont(ofSize: 0)
        let s = NSMutableAttributedString(string: st.name, attributes: [.font: font])
        var extra = "   :\(st.port) · \(st.framework)"
        if let b = st.branch { extra += " · ⎇ \(b)" }
        if st.health == "slow" { extra += " · не отвечает" }
        s.append(NSAttributedString(string: extra, attributes: [.font: font, .foregroundColor: NSColor.secondaryLabelColor]))
        return s
    }

    // MARK: QR-код

    @objc func showQR() {
        guard let url = iPadURL else { return }
        let w: CGFloat = 320
        if qrWindow == nil {
            let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: w, height: w + 96),
                               styleMask: [.titled, .closable], backing: .buffered, defer: false)
            win.title = "Открыть на iPad"
            win.isReleasedWhenClosed = false
            win.center()
            qrWindow = win
        }
        let content = NSView(frame: NSRect(x: 0, y: 0, width: w, height: w + 96))
        let box = NSImageView(frame: NSRect(x: 32, y: 96, width: w - 64, height: w - 64))
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.white.cgColor
        box.layer?.cornerRadius = 12
        box.imageScaling = .scaleNone
        box.image = qrImage(url, side: w - 96)
        let label = NSTextField(wrappingLabelWithString: "Наведи камеру iPad на код или открой\n\(url)")
        label.frame = NSRect(x: 16, y: 48, width: w - 32, height: 40)
        label.alignment = .center
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        label.isSelectable = true
        let button = NSButton(title: "Скопировать адрес", target: self, action: #selector(copyIPadURL))
        button.bezelStyle = .rounded
        button.sizeToFit()
        button.frame.origin = NSPoint(x: (w - button.frame.width) / 2, y: 12)
        content.addSubview(box)
        content.addSubview(label)
        content.addSubview(button)
        qrWindow?.contentView = content
        qrWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func qrImage(_ text: String, side: CGFloat) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = filter.outputImage else { return nil }
        let scale = floor(side * 2 / out.extent.width)
        let scaled = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        let size = scaled.extent.width / 2
        return NSImage(cgImage: cg, size: NSSize(width: size, height: size))
    }

    // MARK: Действия

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @objc func openStand(_ sender: NSMenuItem) {
        let local = state?.stands.first(where: { $0.port == sender.tag })?.localUrl ?? "http://localhost:\(sender.tag)/"
        if let url = URL(string: local) { NSWorkspace.shared.open(url) }
    }

    @objc func copyStandLink(_ sender: NSMenuItem) {
        guard let st = state?.stands.first(where: { $0.port == sender.tag }) else { return }
        copy(iPadURL(for: st) ?? "http://localhost:\(st.port)/")
    }

    @objc func openDashboard() {
        if let url = URL(string: "http://localhost:\(dashPort)/") { NSWorkspace.shared.open(url) }
    }

    @objc func copyIPadURL() {
        if let url = iPadURL { copy(url) }
    }

    @objc func toggleKeepAwake() {
        post("api/keep-awake", ["on": !(state?.keepAwake ?? false)])
    }

    @objc func toggleStatusItem() {
        UserDefaults.standard.set(statusItem != nil, forKey: "hideStatusItem")
        updateStatusItemVisibility()
    }

    @objc func toggleLoginItem() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
            if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Не удалось изменить автозапуск"
            alert.informativeText = error.localizedDescription
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    func enableLoginItemOnFirstLaunch() {
        let key = "loginItemConfigured"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        try? SMAppService.mainApp.register()
    }

    @objc func openConfig() {
        let textEdit = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        NSWorkspace.shared.open([configURL], withApplicationAt: textEdit, configuration: NSWorkspace.OpenConfiguration())
    }

    @objc func openLog() {
        NSWorkspace.shared.open(logURL)
    }

    @objc func restartServer() {
        server.restart()
        dashboardLoaded = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.poll() }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }

    func post(_ path: String, _ body: [String: Any]) {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.poll() }
        }.resume()
    }
}

// MARK: - main

if CommandLine.arguments.contains("--unregister-login-item") {
    try? SMAppService.mainApp.unregister()
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
