// Local page for the bedroom air conditioner. Serves this folder and forwards
// /stick/... to the SLWF-01pro. The night cycle runs on the stick.
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const schedule = require("./schedule");

const ROOT = __dirname;
const STICK_HOST = "192.168.1.105";
const PORT = 8443;
const CERT_DIR = path.join(ROOT, "certs");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function readCert() {
  return {
    pfx: fs.readFileSync(path.join(CERT_DIR, "air.pfx")),
    passphrase: fs.readFileSync(path.join(CERT_DIR, "passphrase.txt"), "utf8").trim(),
  };
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveFile(req, res) {
  const url = new URL(req.url, "https://local");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.resolve(ROOT, "." + pathname);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (file !== ROOT && !file.startsWith(rootWithSep)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".png" ? "public, max-age=86400" : "no-cache",
    });
    res.end(data);
  });
}

function proxy(req, res) {
  const url = new URL(req.url, "https://local");
  const target = url.pathname.replace(/^\/stick/, "") + url.search;
  const headers = { ...req.headers, host: STICK_HOST };
  delete headers["accept-encoding"];
  // The stick answers 403 when a browser Origin names this computer instead of the stick.
  // The phone only talks to this server, so the forwarded call is not a cross-site request.
  delete headers.origin;
  delete headers.referer;
  const upstream = http.request(
    {
      hostname: STICK_HOST,
      port: 80,
      path: target || "/",
      method: req.method,
      headers,
    },
    (incoming) => {
      const responseHeaders = { ...incoming.headers };
      delete responseHeaders["transfer-encoding"];
      res.writeHead(incoming.statusCode || 502, responseHeaders);
      incoming.pipe(res);
    }
  );
  upstream.setTimeout(0);
  upstream.on("error", () => {
    if (!res.headersSent) send(res, 502, JSON.stringify({ error: "stick unreachable" }), "application/json");
    else res.end();
  });
  req.pipe(upstream);
}

let settings = schedule.loadSettings();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveSchedule(req, res) {
  if (req.method === "GET") {
    send(res, 200, JSON.stringify(schedule.view(new Date(), settings)), "application/json");
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, "Method not allowed");
    return;
  }
  readBody(req)
    .then((raw) => {
      const patch = raw ? JSON.parse(raw) : {};
      settings = schedule.saveSettings({ ...settings, ...patch });
      send(res, 200, JSON.stringify(schedule.view(new Date(), settings)), "application/json");
    })
    .catch(() => send(res, 400, "Bad schedule"));
}

const server = https.createServer(readCert(), (req, res) => {
  const pathname = new URL(req.url, "https://local").pathname;
  if (pathname === "/schedule") serveSchedule(req, res);
  else if (pathname === "/stick" || pathname.startsWith("/stick/")) proxy(req, res);
  else serveFile(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Air controls at https://192.168.1.117:" + PORT);
});
