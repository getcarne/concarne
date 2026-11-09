// concarne static: serve a directory tree as middleware.
// Pure JS on std/os (reads + stat) and std/mimetype (content types).
//
//   app.use(concarne.static("./public"));
//   app.use("/assets", concarne.static("./public", {strip: "/assets"}));
//
// Only GET/HEAD run; anything else (and any miss) calls next() so the
// app's own routes and 404 own the request. Files go out as Uint8Array
// bodies (binary-safe, NULs included) with ETag/Last-Modified and
// 304 handling. Symlinks are followed; dotfiles answer like misses.

var os = require("std/os");
var contentTypeFor = require("./contenttype.js").contentTypeFor;

function decodeSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null;
  }
}

function serveStatic(root, opts) {
  if (typeof root !== "string" || root === "") {
    throw new Error("concarne.static: root must be a directory path");
  }
  opts = opts || {};
  if (typeof opts !== "object" || Array.isArray(opts)) {
    throw new Error("concarne.static: opts must be an object");
  }
  var index = opts.index === undefined ? "index.html" : opts.index;
  var maxAge = opts.maxAge === undefined ? 0 : opts.maxAge;
  var strip = opts.strip === undefined ? "" : opts.strip;
  if (index !== null && typeof index !== "string") {
    throw new Error("concarne.static: index must be a file name or null");
  }
  if (typeof maxAge !== "number" || maxAge < 0) {
    throw new Error("concarne.static: maxAge must be seconds >= 0");
  }
  if (typeof strip !== "string") {
    throw new Error("concarne.static: strip must be a path prefix");
  }
  while (root.length > 1 && root[root.length - 1] === "/") {
    root = root.slice(0, -1);
  }

  function resolve(rel) {
    var segs = rel.split("/");
    var clean = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = decodeSegment(segs[i]);
      if (seg === null) return null;
      if (seg === "" || seg === ".") continue;
      if (seg === ".." || seg.indexOf("/") >= 0) return null;
      if (seg.indexOf("\0") >= 0) return null;
      if (seg[0] === ".") return null;
      clean.push(seg);
    }
    return root + "/" + clean.join("/");
  }

  function statFile(path) {
    var st;
    try {
      st = os.stat(path);
    } catch (e) {
      return null;
    }
    if (st.kind !== "file") return null;
    return st;
  }

  return function staticMiddleware(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    var rel = req.path;
    if (strip !== "") {
      if (rel !== strip && rel.slice(0, strip.length + 1) !== strip + "/") {
        return next();
      }
      rel = rel.slice(strip.length) || "/";
    }
    var fsPath = resolve(rel);
    if (fsPath === null) return next();
    var st = statFile(fsPath);
    if (st === null) {
      // Directories resolve their index (redirecting to the slash
      // form first so relative URLs keep working); anything else is
      // a miss for downstream middleware.
      var dst;
      try {
        dst = os.isDir(fsPath);
      } catch (e) {
        return next();
      }
      if (!dst || !index) return next();
      if (req.path[req.path.length - 1] !== "/") {
        res.redirect(req.path + "/", 301);
        return;
      }
      fsPath = fsPath + "/" + index;
      st = statFile(fsPath);
      if (st === null) return next();
    }
    var etag = '"' + st.size + "-" + st.mtimeMs + '"';
    if (req.get("if-none-match") === etag) {
      res.status(304).set("ETag", etag).end();
      return;
    }
    var since = req.get("if-modified-since");
    if (since) {
      var t = Date.parse(since);
      if (!isNaN(t) &&
          Math.floor(st.mtimeMs / 1000) <= Math.floor(t / 1000)) {
        res.status(304).set("ETag", etag).end();
        return;
      }
    }
    var data;
    try {
      data = os.readFileBytes(fsPath);
    } catch (e) {
      return next();
    }
    res.set("Content-Type", contentTypeFor(fsPath));
    res.set("ETag", etag);
    res.set("Last-Modified", new Date(st.mtimeMs).toUTCString());
    if (maxAge > 0) {
      res.set("Cache-Control", "public, max-age=" + Math.floor(maxAge));
    }
    res.send(data);
  };
}

module.exports = {serveStatic: serveStatic};
