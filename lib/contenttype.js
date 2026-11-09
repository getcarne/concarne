// Shared filename -> Content-Type mapping (static serving and
// res.sendFile). mimedb gives bare types; text types gain an explicit
// charset like res.type() uses. Unknown extensions fall back to
// application/octet-stream so binary stays binary.

var mimetype = require("std/mimetype");

function contentTypeFor(name) {
  var dot = name.lastIndexOf(".");
  var type = dot >= 0 ? mimetype.lookup(name.slice(dot + 1)) : null;
  if (type === null || type === undefined || type === "") {
    return "application/octet-stream";
  }
  if (type.slice(0, 5) === "text/") {
    return type + "; charset=utf-8";
  }
  return type;
}

module.exports = {contentTypeFor: contentTypeFor};
