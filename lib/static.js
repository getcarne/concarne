// concarne static: serve a directory tree as middleware, zero-copy.
// Pure JS resolution on std/os (reads + stat); the bytes go out via
// res.sendFile, so the runtime sends them from disk with sendfile:
// no body buffering, no JS heap copy. Range requests, conditional
// revalidation (ETag/Last-Modified, 304s) and HEAD all come from the
// file serving itself.
//
//   app.use(concarne.static("./public"));
//   app.use("/assets", concarne.static("./public", {strip: "/assets"}));
//
// Only GET/HEAD run; anything else (and any miss) calls next() so the
// app's own routes and 404 own the request. Symlinks are followed;
// dotfiles answer like misses.

const os = require("std/os");

/**
 * Decodes one URL segment.
 * @param {string} s the raw segment
 * @returns {string|null} the decoded segment, or null when garbage
 */
function decodeSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return null;
  }
}

/**
 * Builds the static middleware.
 * @param {string} root the directory to serve
 * @param {object} [opts] `{index?, maxAge?, strip?}`: `index` is the
 *   directory index file (default `"index.html"`, `null` disables);
 *   `maxAge` seconds for `Cache-Control` (default `0`, unset); `strip`
 *   removes a mount prefix before mapping (for mounted use)
 * @returns {Function} middleware (req, res, next)
 */
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

  /**
   * Maps a request path under the root: segments decode, `.` drops,
   * and `..`, slashes-in-segment, NULs and dotfiles are misses (null).
   * The result stays lexically under root; symlinks resolve at open.
   * @param {string} rel the request path (prefix already stripped)
   * @returns {string|null} the file path, or null on miss
   */
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
    var isFile = false;
    try {
      isFile = os.isFile(fsPath);
    } catch (e) {
      isFile = false;
    }
    if (!isFile) {
      // Directories resolve their index (redirecting to the slash
      // form first so relative URLs keep working); anything else is
      // a miss for downstream middleware.
      var isDir = false;
      try {
        isDir = os.isDir(fsPath);
      } catch (e) {
        isDir = false;
      }
      if (!isDir || !index) return next();
      if (req.path[req.path.length - 1] !== "/") {
        res.redirect(req.path + "/", 301);
        return;
      }
      fsPath = fsPath + "/" + index;
    }
    // Cache-Control is ours; Content-Type, ETag, Last-Modified,
    // ranges and conditionals belong to the zero-copy file serving.
    if (maxAge > 0) {
      res.set("Cache-Control", "public, max-age=" + Math.floor(maxAge));
    }
    res.sendFile(fsPath);
  };
}

module.exports = {serveStatic: serveStatic};
