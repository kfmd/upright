#!/usr/bin/env python3
"""
Upright - a local posture reminder.   Start it with:   python3 server.py

* First run needs internet ONCE (downloads the pose-detection model). After that it is fully offline.
* This Mac:      http://localhost:8000
* Other devices: https://<your-mac-ip>:8443   (browsers show a one-time "not private" warning because
                 the certificate is made by this script - choose Advanced > Proceed. The camera needs https.)
Only the Python standard library is used (plus the `openssl` tool that macOS already has).
"""
import io, json, re, socket, ssl, subprocess, tarfile, threading, urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).parent.resolve()
WEB, DATA = ROOT / "web", ROOT / "data"
VENDOR = WEB / "vendor"
HTTP_PORT, HTTPS_PORT = 8000, 8443
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
             "pose_landmarker_lite/float16/1/pose_landmarker_lite.task")   # swap "lite" for "full" = more accurate, slower
LOCK = threading.Lock()
PROFILES = DATA / "profiles.json"
NAME_OK = re.compile(r"^[\w\- ]{1,24}$")


def slug(name):  # "Sam  Lee" -> "sam-lee"
    return re.sub(r"\s+", "-", name.strip().lower())


def load():
    return json.loads(PROFILES.read_text()) if PROFILES.exists() else {}


def save(db):
    tmp = PROFILES.with_suffix(".tmp")
    tmp.write_text(json.dumps(db))
    tmp.replace(PROFILES)


# ---------- one-time downloads ----------
def ensure_assets():
    VENDOR.mkdir(parents=True, exist_ok=True)
    if not (VENDOR / "vision_bundle.mjs").exists():
        print("First run: downloading MediaPipe from npm (one time)...")
        meta = json.load(urllib.request.urlopen("https://registry.npmjs.org/@mediapipe/tasks-vision/latest"))
        blob = urllib.request.urlopen(meta["dist"]["tarball"]).read()
        with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
            for m in tar.getmembers():
                name = m.name.split("/", 1)[-1]
                if m.isfile() and (name == "vision_bundle.mjs" or name.startswith("wasm/")):
                    dest = VENDOR / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(tar.extractfile(m).read())
    if not (VENDOR / "pose.task").exists():
        print("First run: downloading the pose model (one time)...")
        (VENDOR / "pose.task").write_bytes(urllib.request.urlopen(MODEL_URL).read())


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):  # self-signed certificate, rebuilt if the Mac's wifi IP changes
    DATA.mkdir(exist_ok=True)
    cert, key, stamp, cfg = DATA / "cert.pem", DATA / "key.pem", DATA / "cert.ip", DATA / "openssl.cnf"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == ip:
        return cert, key
    cfg.write_text("[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Upright\n"
                   f"[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
                    "-keyout", str(key), "-out", str(cert), "-config", str(cfg)], check=True, capture_output=True)
    stamp.write_text(ip)
    return cert, key


# ---------- web server ----------
class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def setup(self):  # finish the TLS handshake in this connection's own thread
        if isinstance(self.request, ssl.SSLSocket):
            self.request.settimeout(10)
            self.request.do_handshake()
        super().setup()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def api(self):  # /api/profiles[/<name>]
        parts = unquote(self.path.split("?")[0]).strip("/").split("/")
        key = slug(parts[2]) if len(parts) > 2 else None
        with LOCK:
            db = load()
            if self.command == "GET":
                if key is None:
                    return self.reply(200, [{"name": p["name"]} for p in db.values()])
                return self.reply(200, db[key]) if key in db else self.reply(404, {})
            if self.command == "PUT" and key:
                n = int(self.headers.get("Content-Length", 0))
                if n > 100_000:
                    return self.reply(413, {})
                try:
                    p = json.loads(self.rfile.read(n))
                except ValueError:
                    return self.reply(400, {})
                if not (isinstance(p, dict) and NAME_OK.match(str(p.get("name", ""))) and slug(p["name"]) == key):
                    return self.reply(400, {})
                db[key] = p
                save(db)
                return self.reply(200, {})
            if self.command == "DELETE" and key:
                db.pop(key, None)
                save(db)
                return self.reply(200, {})
        self.reply(404, {})

    def do_GET(self):
        self.api() if self.path.startswith("/api/") else super().do_GET()

    def do_PUT(self):
        self.api()

    def do_DELETE(self):
        self.api()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, ctx=None):
        super().__init__(addr, Handler)
        self.ctx = ctx

    def get_request(self):
        sock, addr = super().get_request()
        if self.ctx:
            sock = self.ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False)
        return sock, addr

    def handle_error(self, *a):  # browsers often drop self-signed connections; ignore the noise
        pass


def main():
    try:
        ensure_assets()
    except Exception as e:
        print(f"\nDownload failed: {e}\nConnect to the internet and run this again (only needed once).")
        return
    DATA.mkdir(exist_ok=True)
    ip = lan_ip()
    cert, key = ensure_cert(ip)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    threading.Thread(target=Server(("127.0.0.1", HTTP_PORT)).serve_forever, daemon=True).start()
    print(f"\n  Upright is running.\n\n  You:      http://localhost:{HTTP_PORT}\n"
          f"  Partner:  https://{ip}:{HTTPS_PORT}   (same wifi; accept the one-time warning)\n\n  Ctrl+C to stop.\n")
    try:
        Server(("0.0.0.0", HTTPS_PORT), ctx).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
