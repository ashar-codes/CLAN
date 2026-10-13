// Local Vision recognition. Input is an explicitly imported private image; no network or logs.
import Foundation
import Vision
import ImageIO
let args=CommandLine.arguments
guard args.count==2,let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:args[1]) as CFURL,nil),let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [String:Any],let w=props[kCGImagePropertyPixelWidth as String] as? Int,let h=props[kCGImagePropertyPixelHeight as String] as? Int,w>0,h>0,w<=10000,h<=10000,w*h<=20000000 else{exit(1)}
let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=false
let orientation=CGImagePropertyOrientation(rawValue:(props[kCGImagePropertyOrientation as String] as? UInt32) ?? 1) ?? .up
try VNImageRequestHandler(url:URL(fileURLWithPath:args[1]),orientation:orientation,options:[:]).perform([request])
let rows=(request.results ?? []).sorted {a,b in abs(a.boundingBox.midY-b.boundingBox.midY)>0.015 ? a.boundingBox.midY>b.boundingBox.midY:a.boundingBox.minX<b.boundingBox.minX}.prefix(400).compactMap{r->[String:Any]? in guard let t=r.topCandidates(1).first else{return nil};return ["text":String(t.string.prefix(300)),"confidence":t.confidence,"x":r.boundingBox.minX,"y":r.boundingBox.midY]}
let data=try JSONSerialization.data(withJSONObject:["lines":rows]);FileHandle.standardOutput.write(data)
