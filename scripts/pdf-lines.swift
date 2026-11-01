// Prints a PDF's text as JSON, line by line with each line's position and font
// size, for scripts/book-to-markdown.mjs. macOS only: it uses PDFKit, so there
// is nothing to install. Positions are in PDF points from the page's bottom left.
//
//   swift scripts/pdf-lines.swift Book.pdf > lines.json
import AppKit
import Foundation
import PDFKit

struct Line: Encodable {
  let x: Double, y: Double, w: Double, h: Double, size: Double
  let text: String
}

struct Page: Encodable {
  let index: Int
  let width: Double, height: Double
  let lines: [Line]
}

struct Book: Encodable {
  let title: String?
  let pages: [Page]
}

let round1 = { (v: CGFloat) in (Double(v) * 10).rounded() / 10 }

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("pdf-lines: \(message)\n".data(using: .utf8)!)
  exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: swift pdf-lines.swift Book.pdf") }
guard let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else { fail("not a PDF that can be opened") }
if doc.isLocked { fail("the PDF is locked with a password") }

var pages: [Page] = []
for index in 0..<doc.pageCount {
  guard let page = doc.page(at: index) else { continue }
  let box = page.bounds(for: .cropBox)
  var lines: [Line] = []
  for line in page.selection(for: box)?.selectionsByLine() ?? [] {
    let text = (line.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    // The size most of the line's characters have.
    var sizes: [Double: Int] = [:]
    if let attributed = line.attributedString {
      attributed.enumerateAttribute(.font, in: NSRange(location: 0, length: attributed.length)) { value, range, _ in
        if let font = value as? NSFont { sizes[round1(font.pointSize), default: 0] += range.length }
      }
    }
    let b = line.bounds(for: page)
    lines.append(Line(
      x: round1(b.minX - box.minX), y: round1(b.minY - box.minY), w: round1(b.width), h: round1(b.height),
      size: sizes.max { $0.value < $1.value }?.key ?? round1(b.height), text: text))
  }
  pages.append(Page(index: index, width: round1(box.width), height: round1(box.height), lines: lines))
}

let title = doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String
let encoder = JSONEncoder()
FileHandle.standardOutput.write(try encoder.encode(Book(title: title, pages: pages)))
