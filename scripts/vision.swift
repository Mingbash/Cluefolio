import Foundation
import Vision
import AppKit
struct Line: Codable {let text:String; let confidence:Float; let box:[Double]}
struct Result: Codable {let file:String; let lines:[Line]; let error:String?}
var results:[Result]=[]
for filename in CommandLine.arguments.dropFirst() {
 do {
  let url=URL(fileURLWithPath:filename)
  let req=VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = ["zh-Hans","zh-Hant","en-US"]
  req.usesLanguageCorrection = true
  try VNImageRequestHandler(url:url).perform([req])
  let lines=(req.results ?? []).compactMap { obs -> Line? in
   guard let c=obs.topCandidates(1).first else { return nil }
   return Line(text:c.string,confidence:c.confidence,box:[obs.boundingBox.origin.x,obs.boundingBox.origin.y,obs.boundingBox.width,obs.boundingBox.height])
  }
  results.append(Result(file:filename,lines:lines,error:nil))
 } catch {results.append(Result(file:filename,lines:[],error:error.localizedDescription))}
}
let data=try JSONEncoder().encode(results)
print(String(data:data,encoding:.utf8)!)
