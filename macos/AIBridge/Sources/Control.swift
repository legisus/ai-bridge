// Unix-socket control channel between the CLI and the recorder in the app.
// ~/.ai-browser-bridge/app.sock, mode 0600 inside a 0700 directory. One request
// per connection: a JSON line {"cmd":…, "params":{…}} → a JSON line reply.

import Foundation

final class ControlServer: @unchecked Sendable {
    private let path: String
    private let hub: RecorderHub

    init(stateDir: URL, hub: RecorderHub) {
        path = stateDir.appendingPathComponent("app.sock").path
        self.hub = hub
    }

    func start() {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { close(fd); return }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = UInt8(bitPattern: b) }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) }
        }
        guard ok == 0 else { close(fd); return }
        chmod(path, 0o600)
        listen(fd, 8)
        let hub = self.hub
        Thread.detachNewThread {
            while true {
                let c = accept(fd, nil, nil)
                if c < 0 { if errno == EINTR { continue }; return }
                DispatchQueue.global().async { ControlServer.serve(c, hub: hub) }
            }
        }
    }

    private static func serve(_ c: Int32, hub: RecorderHub) {
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while !buf.contains(10) && buf.count < 4_000_000 {
            let n = read(c, &chunk, chunk.count)
            if n <= 0 { break }
            buf.append(chunk, count: n)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: buf) as? [String: Any], let cmd = obj["cmd"] as? String else {
            reply(c, ["ok": false, "error": "bad request"]); return
        }
        let params = obj["params"] as? [String: Any] ?? [:]
        Task {
            let r = await hub.handle(cmd: cmd, params: params)
            reply(c, r)
        }
    }

    private static func reply(_ c: Int32, _ obj: [String: Any]) {
        var d = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false}".utf8)
        d.append(10)
        d.withUnsafeBytes { p in
            var off = 0
            while off < d.count {
                let n = write(c, p.baseAddress! + off, d.count - off)
                if n <= 0 { break }
                off += n
            }
        }
        close(c)
    }
}
