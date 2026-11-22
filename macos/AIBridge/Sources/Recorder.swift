// Window recorder: ScreenCaptureKit (one window + its app's audio) → AVAssetWriter
// (H.264 + AAC, fragmented mp4 written straight to disk) with a steps journal.
//
// Lives in the menu-bar app so the "Screen & System Audio Recording" permission
// belongs to *this app* and not to the terminal / Claude. The CLI talks to it over
// a unix socket (see Control.swift); the server drops click/type/key/navigate events
// into <recId>.events.jsonl while a recording is active.

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreGraphics
import AppKit

struct RecError: Error { let code: String; let message: String }

let permissionMessage =
    "Screen recording is not allowed for AI Browser Bridge. Open System Settings → Privacy & Security → " +
    "Screen & System Audio Recording, turn on “AI Browser Bridge” (add it with + if missing; " +
    "/Applications/AI Browser Bridge.app), then quit and reopen the app and retry."

final class Recording: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let id: String
    let mp4: URL
    let eventsURL: URL
    let activeURL: URL
    let windowTitle: String
    let appName: String
    let windowID: UInt32
    let fps: Int
    let wantAudio: Bool
    let size: (w: Int, h: Int)

    private let q = DispatchQueue(label: "ai-bridge.recorder.samples")
    private var stream: SCStream?
    private var writer: AVAssetWriter!
    private var vIn: AVAssetWriterInput!
    private var aIn: AVAssetWriterInput?

    private var started = false
    private var finalized = false
    private var firstPTS = CMTime.invalid
    private var lastPTS = CMTime.invalid
    private(set) var firstEpoch: Double = 0
    private(set) var frames = 0
    private(set) var audioBuffers = 0
    private(set) var failure: String?
    private(set) var durationSec: Double = 0
    private var marks: [[String: Any]] = []
    let startedWall = Date()

    init(id: String, dir: URL, window: SCWindow, fps: Int, audio: Bool, cursor: Bool) async throws {
        self.id = id
        mp4 = dir.appendingPathComponent("\(id).mp4")
        eventsURL = dir.appendingPathComponent("\(id).events.jsonl")
        activeURL = dir.appendingPathComponent("\(id).active")
        windowTitle = window.title ?? ""
        appName = window.owningApplication?.applicationName ?? ""
        windowID = window.windowID
        self.fps = fps
        wantAudio = audio

        let filter = SCContentFilter(desktopIndependentWindow: window)
        var scale: CGFloat = NSScreen.main?.backingScaleFactor ?? 2
        if #available(macOS 14.0, *) { scale = CGFloat(SCShareableContent.info(for: filter).pointPixelScale) }
        let w = max(2, Int(window.frame.width * scale) & ~1)
        let h = max(2, Int(window.frame.height * scale) & ~1)
        size = (w, h)
        super.init()

        let cfg = SCStreamConfiguration()
        cfg.width = w; cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = cursor
        cfg.queueDepth = 6
        cfg.scalesToFit = true          // window resized mid-recording → content is rescaled into the fixed frame
        if #available(macOS 14.0, *) { cfg.preservesAspectRatio = true }
        if audio {
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true
            cfg.sampleRate = 48000
            cfg.channelCount = 2
        }

        try? FileManager.default.removeItem(at: mp4)
        writer = try AVAssetWriter(outputURL: mp4, fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 600) // survives a crash; long recordings stay on disk
        let bitrate = min(max(Int(Double(w * h * fps) * 0.07), 4_000_000), 24_000_000)
        vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
                AVVideoExpectedSourceFrameRateKey: fps,
            ],
        ])
        vIn.expectsMediaDataInRealTime = true
        writer.add(vIn)
        if audio {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
            ])
            a.expectsMediaDataInRealTime = true
            writer.add(a)
            aIn = a
        }
        guard writer.startWriting() else { throw RecError(code: "writer", message: writer.error?.localizedDescription ?? "cannot start writer") }

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        if audio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q) }
        stream = s
        try await s.startCapture()
    }

    // MARK: samples (all on q)

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid, !finalized else { return }
        switch type {
        case .screen:
            guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = atts.first?[.status] as? Int, raw == SCFrameStatus.complete.rawValue,
                  CMSampleBufferGetImageBuffer(sb) != nil else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb)
            if !started {
                started = true
                firstPTS = pts
                let lag = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts))
                firstEpoch = Date().timeIntervalSince1970 - max(0, lag)
                writer.startSession(atSourceTime: pts)
                try? "{\"recId\":\"\(id)\",\"firstEpoch\":\(firstEpoch)}".write(to: activeURL, atomically: true, encoding: .utf8)
            }
            if vIn.isReadyForMoreMediaData, writer.status == .writing {
                vIn.append(sb); frames += 1; lastPTS = pts
            }
        case .audio:
            guard started, let a = aIn, a.isReadyForMoreMediaData, writer.status == .writing,
                  CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sb), firstPTS) >= 0 else { return }
            if a.append(sb) { audioBuffers += 1 }
        default: break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // window closed / display went away: keep what we have, make the file valid
        failure = error.localizedDescription
        Task { await self.finalize(stopStream: false) }
    }

    // MARK: control

    func addMark(_ label: String, extra: [String: Any]) -> Double {
        let t = started ? Date().timeIntervalSince1970 - firstEpoch : 0
        q.sync {
            var m: [String: Any] = ["t": (t * 1000).rounded() / 1000, "type": "mark", "label": label]
            for (k, v) in extra { m[k] = v }
            marks.append(m)
        }
        return t
    }

    func marksSnapshot() -> [[String: Any]] { q.sync { marks } }
    var started_: Bool { q.sync { started } }

    /// Stop capture and close the file. Safe to call twice.
    func finalize(stopStream: Bool = true) async {
        if stopStream, let s = stream { try? await s.stopCapture() }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            q.async { [self] in
                if finalized { c.resume(); return }
                finalized = true
                guard started else { writer.cancelWriting(); c.resume(); return }
                let now = CMClockGetTime(CMClockGetHostTimeClock())
                // end the session "now" (not at the last frame): a static page sends few frames,
                // the video must still last as long as the recording did
                let end = stopStream ? now : lastPTS
                durationSec = max(0, CMTimeGetSeconds(CMTimeSubtract(end, firstPTS)))
                vIn.markAsFinished(); aIn?.markAsFinished()
                writer.endSession(atSourceTime: end)
                writer.finishWriting {
                    if self.writer.status == .failed { self.failure = self.writer.error?.localizedDescription }
                    c.resume()
                }
            }
        }
        try? FileManager.default.removeItem(at: activeURL)
    }
}

actor RecorderHub {
    let dir: URL
    private var recs: [String: Recording] = [:]

    init(stateDir: URL) {
        dir = stateDir.appendingPathComponent("recordings")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // leftovers from a crashed run must not make the server log events forever
        if let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for f in items where f.hasSuffix(".active") { try? FileManager.default.removeItem(at: dir.appendingPathComponent(f)) }
        }
    }

    func handle(cmd: String, params: [String: Any]) async -> [String: Any] {
        do {
            switch cmd {
            case "recordStart": return try await start(params)
            case "recordStop": return try await stop(params)
            case "recordStatus": return status()
            case "mark": return try mark(params)
            default: throw RecError(code: "unknown", message: "unknown command \(cmd)")
            }
        } catch let e as RecError {
            return ["ok": false, "code": e.code, "error": e.message]
        } catch {
            return ["ok": false, "code": "error", "error": error.localizedDescription]
        }
    }

    private func findWindow(_ spec: String) async throws -> SCWindow {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()   // shows the system prompt the first time
            throw RecError(code: "permission", message: permissionMessage)
        }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) }
        catch { throw RecError(code: "permission", message: permissionMessage + " (\(error.localizedDescription))") }

        let all = content.windows.filter {
            $0.windowLayer == 0 && $0.frame.width >= 200 && $0.frame.height >= 100 && $0.owningApplication != nil
        }
        var s = spec.trimmingCharacters(in: .whitespaces)
        if s.isEmpty { s = "app=Google Chrome" }
        let needle: String
        let match: (SCWindow) -> Bool
        if s.lowercased().hasPrefix("app=") {
            needle = String(s.dropFirst(4)).lowercased()
            match = { w in
                let a = w.owningApplication
                return (a?.applicationName ?? "").lowercased().contains(needle) || (a?.bundleIdentifier ?? "").lowercased() == needle
            }
        } else {
            needle = s.lowercased()
            match = { ($0.title ?? "").lowercased().contains(needle) }
        }
        let hits = all.filter(match)
        guard !hits.isEmpty else {
            let titles = all.prefix(12).map { "\($0.owningApplication?.applicationName ?? "?"): \($0.title ?? "")" }
            throw RecError(code: "no_window", message: "no on-screen window matches “\(spec.isEmpty ? "app=Google Chrome" : spec)”. Visible: \(titles.joined(separator: " | "))")
        }
        return hits.first(where: { $0.isActive }) ?? hits[0]
    }

    private func start(_ p: [String: Any]) async throws -> [String: Any] {
        let spec = (p["window"] as? String) ?? ""
        let fps = min(max((p["fps"] as? Int) ?? 30, 1), 60)
        let audio = (p["audio"] as? Bool) ?? true
        let cursor = (p["cursor"] as? Bool) ?? true
        let win = try await findWindow(spec)
        let id = "rec-" + String(UUID().uuidString.prefix(8).lowercased())
        let r: Recording
        do { r = try await Recording(id: id, dir: dir, window: win, fps: fps, audio: audio, cursor: cursor) }
        catch let e as RecError { throw e }
        catch {
            let m = error.localizedDescription
            if m.lowercased().contains("declined") || m.lowercased().contains("permission") { throw RecError(code: "permission", message: permissionMessage) }
            throw RecError(code: "start", message: "cannot start capture: \(m)")
        }
        recs[id] = r
        // so the server starts logging immediately (firstEpoch is rewritten at the first frame)
        try? "{\"recId\":\"\(id)\"}".write(to: r.activeURL, atomically: true, encoding: .utf8)
        return ["ok": true, "recId": id, "window": ["title": r.windowTitle, "app": r.appName, "id": Int(r.windowID)],
                "size": ["w": r.size.w, "h": r.size.h], "fps": fps, "audio": audio, "cursor": cursor,
                "audioScope": audio ? "app (all windows of \(r.appName))" : "none"]
    }

    private func get(_ p: [String: Any]) throws -> Recording {
        let id = (p["recId"] as? String) ?? (recs.count == 1 ? recs.keys.first! : "")
        guard let r = recs[id] else { throw RecError(code: "no_recording", message: "no such recording: \(id.isEmpty ? "(pass recId)" : id)") }
        return r
    }

    private func mark(_ p: [String: Any]) throws -> [String: Any] {
        let r = try get(p)
        var extra: [String: Any] = [:]
        for (k, v) in p where k != "recId" && k != "label" { extra[k] = v }
        let t = r.addMark((p["label"] as? String) ?? "", extra: extra)
        return ["ok": true, "recId": r.id, "t": (t * 1000).rounded() / 1000]
    }

    private func status() -> [String: Any] {
        let list: [[String: Any]] = recs.values.map { r in
            let size = (try? FileManager.default.attributesOfItem(atPath: r.mp4.path)[.size] as? Int) ?? 0
            var d: [String: Any] = ["recId": r.id, "elapsedSec": Int(Date().timeIntervalSince(r.startedWall)),
                "frames": r.frames, "audioBuffers": r.audioBuffers, "marks": r.marksSnapshot().count,
                "bytes": size, "window": r.windowTitle, "app": r.appName]
            if let f = r.failure { d["error"] = f }
            return d
        }
        return ["ok": true, "permission": CGPreflightScreenCaptureAccess(), "recordings": list]
    }

    private func stop(_ p: [String: Any]) async throws -> [String: Any] {
        let r = try get(p)
        await r.finalize()
        recs[r.id] = nil
        guard r.frames > 0 else {
            try? FileManager.default.removeItem(at: r.mp4)
            throw RecError(code: "no_frames", message: "no frames were captured (window minimized or covered by a fullscreen Space?)" + (r.failure.map { " — \($0)" } ?? ""))
        }

        // steps = marks + bridge events (click/type/key/navigate…) logged by the server
        var steps = r.marksSnapshot()
        if let text = try? String(contentsOf: r.eventsURL, encoding: .utf8) {
            var ends: [String: Double] = [:]
            var evs: [[String: Any]] = []
            for line in text.split(separator: "\n") {
                guard let o = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                if let e = o["end"] as? Double, let id = o["id"] as? String { ends[id] = e } else { evs.append(o) }
            }
            for var e in evs {
                guard let ms = e["at"] as? Double else { continue }
                var s: [String: Any] = e
                s["t"] = ((ms / 1000 - r.firstEpoch) * 1000).rounded() / 1000
                s.removeValue(forKey: "at")
                if let id = e["id"] as? String, let endMs = ends[id] { s["end"] = ((endMs / 1000 - r.firstEpoch) * 1000).rounded() / 1000 }
                e = s
                if (e["t"] as! Double) >= -1 { steps.append(e) }
            }
            try? FileManager.default.removeItem(at: r.eventsURL)
        }
        steps.sort { (($0["t"] as? Double) ?? 0) < (($1["t"] as? Double) ?? 0) }
        var out: [String: Any] = ["ok": true, "recId": r.id, "file": r.mp4.path, "durationSec": (r.durationSec * 100).rounded() / 100,
            "frames": r.frames, "audioBuffers": r.audioBuffers, "steps": steps,
            "window": ["title": r.windowTitle, "app": r.appName], "size": ["w": r.size.w, "h": r.size.h], "fps": r.fps]
        if let f = r.failure { out["warning"] = f }
        return out
    }
}
