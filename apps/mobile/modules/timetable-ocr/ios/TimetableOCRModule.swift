import ExpoModulesCore
import Vision
import ImageIO
public class TimetableOCRModule:Module {
 public func definition()->ModuleDefinition {
  Name("TimetableOCR")
  AsyncFunction("recognize") { (uri:String)->[String:Any] in
   guard let url=URL(string:uri),url.isFileURL,let documents=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask).first,url.resolvingSymlinksInPath().path.hasPrefix(documents.path+"/CLAN/storage/") else {throw NSError(domain:"CLAN",code:1,userInfo:[NSLocalizedDescriptionKey:"Only your imported private timetable images can be recognized."])}
   let attrs=try FileManager.default.attributesOfItem(atPath:url.path);guard let size=attrs[.size] as? NSNumber,size.intValue<=15*1024*1024,let source=CGImageSourceCreateWithURL(url as CFURL,nil),let kind=CGImageSourceGetType(source) as String?,["public.png","public.jpeg"].contains(kind),let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [String:Any],let w=props[kCGImagePropertyPixelWidth as String] as? Int,let h=props[kCGImagePropertyPixelHeight as String] as? Int,w>0,h>0,w<=10000,h<=10000,w*h<=20000000 else {throw NSError(domain:"CLAN",code:2,userInfo:[NSLocalizedDescriptionKey:"Use a PNG/JPEG under 15 MB and 20 MP."])}
   let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=false
   let orientation=CGImagePropertyOrientation(rawValue:(props[kCGImagePropertyOrientation as String] as? UInt32) ?? 1) ?? .up
   try VNImageRequestHandler(url:url,orientation:orientation,options:[:]).perform([request])
   let rows=(request.results ?? []).sorted {a,b in abs(a.boundingBox.midY-b.boundingBox.midY)>0.018 ? a.boundingBox.midY>b.boundingBox.midY:a.boundingBox.minX<b.boundingBox.minX}.prefix(400)
   var lines:[(y:Double,text:String)]=[];var uncertain=false
   for row in rows {guard let candidate=row.topCandidates(1).first else{continue};uncertain = uncertain || candidate.confidence<0.8;let text=String(candidate.string.prefix(300));if let i=lines.indices.first(where:{abs(lines[$0].y-row.boundingBox.midY)<0.018}) {lines[i].text += " "+text} else {lines.append((y:row.boundingBox.midY,text:text))}}
   return ["text":String(lines.map{$0.text}.joined(separator:"\n").prefix(50000)),"uncertain":uncertain]
  }
 }
}
