import { exec } from "herdr";

// pbpaste/pbcopy only handle text. AppKit preserves every clipboard item's types
// and converts pasted or dropped screenshots to PNG without another dependency.
const SCRIPT = `
ObjC.import("AppKit");
function run(args) {
  const pb = $.NSPasteboard.generalPasteboard;
  const unwrap = ObjC.unwrap;
  const dataAt = path => $.NSData.dataWithContentsOfFile(path);
  const textAt = path => unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null));
  const limit = 10 * 1024 * 1024;
  const restore = path => {
    const items = JSON.parse(textAt(path)).items.map(types => {
      const item = $.NSPasteboardItem.alloc.init;
      for (const pair of types)
        item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(pair[1], 0), pair[0]);
      return item;
    });
    pb.clearContents;
    if (items.length && !pb.writeObjects($(items))) throw new Error("Clipboard restore failed.");
  };
  if (args[0] === "count") return String(pb.changeCount);
  if (args[0] === "capture") {
    let source;
    if (args[1]) {
      const attrs = $.NSFileManager.defaultManager.attributesOfItemAtPathError(args[1], null);
      if (!attrs || attrs.isNil()) throw new Error("Image file is missing.");
      if (Number(unwrap(attrs.objectForKey($.NSFileSize))) > limit) throw new Error("Images must be at most 10 MiB.");
      source = dataAt(args[1]);
    }
    else {
      source = pb.dataForType("public.png");
      if (!source || source.isNil()) source = pb.dataForType("public.tiff");
    }
    if (!source || source.isNil()) throw new Error("No image on the clipboard.");
    if (Number(source.length) > limit) throw new Error("Images must be at most 10 MiB.");
    const image = $.NSImage.alloc.initWithData(source);
    if (!image || image.isNil()) throw new Error("Not a supported image.");
    const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
    const png = bitmap.representationUsingTypeProperties($.NSPNGFileType, $({}));
    if (!png || png.isNil() || Number(png.length) > limit)
      throw new Error("PNG images must be at most 10 MiB.");
    const name = unwrap($.NSUUID.UUID.UUIDString).replace(/-/g, "").toLowerCase() + ".png";
    if (!png.writeToFileAtomically(args[2] + "/" + name, true)) throw new Error("Image capture failed.");
    return name;
  }
  if (args[0] === "save") {
    const count = Number(pb.changeCount);
    const items = [];
    const contents = pb.pasteboardItems;
    for (let i = 0; contents && i < Number(contents.count); i++) {
      const item = contents.objectAtIndex(i), types = item.types, saved = [];
      for (let j = 0; j < Number(types.count); j++) {
        const type = types.objectAtIndex(j), data = item.dataForType(type);
        if (data && !data.isNil()) saved.push([unwrap(type), unwrap(data.base64EncodedStringWithOptions(0))]);
      }
      items.push(saved);
    }
    if (Number(pb.changeCount) !== count) throw new Error("Clipboard changed while saving.");
    if (!$(JSON.stringify({ items })).writeToFileAtomicallyEncodingError(args[1], true, $.NSUTF8StringEncoding, null))
      throw new Error("Clipboard save failed.");
    return String(count);
  }
  if (args[0] === "restore") {
    // Do not overwrite something the user copied while the paste was in flight.
    if (Number(pb.changeCount) !== Number(args[2])) return "";
    restore(args[1]);
    return "";
  }
  const item = $.NSPasteboardItem.alloc.init;
  if (args[0] === "image") {
    const data = dataAt(args[1]);
    if (!data || data.isNil()) throw new Error("Image file is missing.");
    item.setDataForType(data, "public.png");
    item.setDataForType($.NSImage.alloc.initWithData(data).TIFFRepresentation, "public.tiff");
  } else if (args[0] === "text") {
    item.setStringForType(textAt(args[1]), "public.utf8-plain-text");
  } else throw new Error("Unknown clipboard operation.");
  if (Number(pb.changeCount) !== Number(args[2])) throw new Error("Clipboard changed during send; paste stopped.");
  pb.clearContents;
  if (!pb.writeObjects($([item]))) {
    restore(args[3]);
    throw new Error("Clipboard copy failed.");
  }
  return String(pb.changeCount);
}
`;

export async function clipboard(operation, ...args) {
  const result = await exec("osascript", ["-l", "JavaScript", "-e", SCRIPT, operation, ...args]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Clipboard operation failed.");
  return result.stdout.trim();
}
