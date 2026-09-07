// Renders AppIcon.iconset PNGs: rounded square with the bridge's neon gradient
// and the connected-nodes symbol. Usage: swift gen-icon.swift <out-dir>
import Cocoa
let out = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
func render(_ px: Int) -> Data {
    let img = NSImage(size: NSSize(width: px, height: px))
    img.lockFocus()
    let r = NSRect(x: 0, y: 0, width: px, height: px).insetBy(dx: CGFloat(px) * 0.05, dy: CGFloat(px) * 0.05)
    let path = NSBezierPath(roundedRect: r, xRadius: CGFloat(px) * 0.22, yRadius: CGFloat(px) * 0.22)
    NSGradient(colors: [NSColor(red: 0, green: 0.9, blue: 1, alpha: 1), NSColor(red: 0.55, green: 0.36, blue: 0.96, alpha: 1), NSColor(red: 1, green: 0.18, blue: 0.77, alpha: 1)])!
        .draw(in: path, angle: -45)
    if let sym = NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: nil)?
        .withSymbolConfiguration(.init(pointSize: CGFloat(px) * 0.5, weight: .semibold)) {
        let tinted = NSImage(size: sym.size, flipped: false) { rect in
            sym.draw(in: rect); NSColor.white.set(); rect.fill(using: .sourceAtop); return true
        }
        let s = tinted.size
        tinted.draw(in: NSRect(x: (CGFloat(px) - s.width) / 2, y: (CGFloat(px) - s.height) / 2, width: s.width, height: s.height))
    }
    img.unlockFocus()
    let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
    return rep.representation(using: .png, properties: [:])!
}
for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128), ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    try! render(px).write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
