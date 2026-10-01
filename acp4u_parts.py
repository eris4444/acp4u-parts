#!/usr/bin/env python3
"""ACP4U Parts - desktop launcher and local service.

Runs the ACP4U Parts app (index.html + xlsx.js) as a desktop program. A small
service listening only on 127.0.0.1 keeps rows, photos and Excel files as real
files in ~/ACP4U-Parts, and the app opens in its own window (Chrome, Chromium,
Brave, Edge or Vivaldi in app mode) or in the default browser. Only the Python
3.8+ standard library is used, so it runs on any Linux distribution.

    acp4u-parts              open the app (starts the service when needed)
    acp4u-parts --status     show where the data lives and whether it runs
    acp4u-parts --stop       stop the background service
    acp4u-parts --update     install the latest version from GitHub
    acp4u-parts --uninstall  remove the program (your data stays)
"""
import argparse
import base64
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = '1.1.0'
REPO = 'eris4444/acp4u-parts'
APP_DIR = Path(__file__).resolve().parent
HOME = Path(os.environ.get('ACP4U_HOME') or (Path.home() / 'ACP4U-Parts')).expanduser()
DATA = HOME / 'data'
PHOTOS = DATA / 'photos'
HISTORY = DATA / 'history'
EXPORTS = HOME / 'Exports'
BACKUPS = HOME / 'Backups'
DB_FILE = DATA / 'records.json'
TOKEN_FILE = DATA / 'token'
STATE_FILE = DATA / 'service.json'
LOG_FILE = DATA / 'service.log'

XDG_DATA = Path(os.environ.get('XDG_DATA_HOME') or (Path.home() / '.local' / 'share'))
INSTALL_DIR = XDG_DATA / 'acp4u-parts'
LAUNCHER = Path.home() / '.local' / 'bin' / 'acp4u-parts'
DESKTOP_FILE = XDG_DATA / 'applications' / 'acp4u-parts.desktop'
ICON_FILE = XDG_DATA / 'icons' / 'hicolor' / 'scalable' / 'apps' / 'acp4u-parts.svg'

BASE_PORT = 47820
IDLE_LIMIT = 30 * 60          # the service exits after 30 minutes without any request
MAX_JSON = 200 * 1024 * 1024  # one saved row with five photos is a few MB
MAX_FILE = 2 * 1024 * 1024 * 1024
SLOTS = 5
FIELDS = {'customerId': 120, 'platform': 40, 'phone': 40, 'location': 80, 'brand': 80,
          'model': 80, 'year': 20, 'vin': 40, 'part': 2000}
REQUIRED = ('customerId', 'brand', 'model', 'year', 'part')
STATIC = {'/': 'index.html', '/index.html': 'index.html', '/xlsx.js': 'xlsx.js', '/icon.svg': 'icon.svg'}
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'}
ID_RE = re.compile(r'^[a-f0-9]{16}$')
CTRL_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
CHROMIUM = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'brave',
            'microsoft-edge', 'microsoft-edge-stable', 'vivaldi', 'vivaldi-stable']
FLATPAK = ['com.google.Chrome', 'org.chromium.Chromium', 'com.brave.Browser', 'com.microsoft.Edge', 'com.vivaldi.Vivaldi']

db_lock = threading.Lock()
last_request = time.time()


class ApiFail(Exception):
    def __init__(self, msg, status=400, code=''):
        super().__init__(msg)
        self.msg, self.status, self.code = msg, status, code


# ---------------------------------------------------------------- files & records

def ensure_dirs():
    for d in (DATA, PHOTOS, HISTORY, EXPORTS, BACKUPS):
        d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(DATA, 0o700)
    except OSError:
        pass


def get_token():
    ensure_dirs()
    try:
        t = TOKEN_FILE.read_text().strip()
        if re.fullmatch(r'[a-f0-9]{32,64}', t):
            return t
    except OSError:
        pass
    t = secrets.token_hex(24)
    TOKEN_FILE.write_text(t)
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    return t


def display(p):
    """/home/me/ACP4U-Parts/Exports -> ~/ACP4U-Parts/Exports"""
    s, home = str(p), str(Path.home())
    return '~' + s[len(home):] if s == home or s.startswith(home + os.sep) else s


def now_ms():
    return int(time.time() * 1000)


def mtime_ms(st):
    return st.st_mtime_ns // 1000000


def write_bytes(path, data):
    tmp = path.with_name('.' + path.name + '.tmp')
    tmp.write_bytes(data)
    os.replace(str(tmp), str(path))


def load_db():
    try:
        rows = json.loads(DB_FILE.read_text('utf-8'))
        return rows if isinstance(rows, list) else []
    except FileNotFoundError:
        return []


def save_db(rows):
    # one copy per day of the rows file, the last 30 days are kept
    snap = HISTORY / 'records-{}.json'.format(date.today().isoformat())
    if DB_FILE.exists() and not snap.exists():
        shutil.copy2(str(DB_FILE), str(snap))
        for old in sorted(HISTORY.glob('records-*.json'))[:-30]:
            old.unlink()
    write_bytes(DB_FILE, json.dumps(rows, ensure_ascii=False).encode('utf-8'))


def clean(value, limit):
    s = str(value if value is not None else '').replace('\r\n', '\n').replace('\r', '\n')
    return CTRL_RE.sub('', s).strip()[:limit]


def photo_path(rid, i, size):
    return PHOTOS / '{}_{}_{}.jpg'.format(rid, i, size)


def jpeg_size(b):
    p = 2
    while p + 9 < len(b):
        if b[p] != 0xFF:
            p += 1
            continue
        m = b[p + 1]
        if m == 0xFF:
            p += 1
            continue
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            p += 2
            continue
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            return (b[p + 7] << 8) | b[p + 8], (b[p + 5] << 8) | b[p + 6]
        p += 2 + ((b[p + 2] << 8) | b[p + 3])
    return 1, 1


def decode_jpeg(b64):
    try:
        data = base64.b64decode(b64 or '', validate=True)
    except (ValueError, TypeError):
        raise ApiFail('A photo could not be read.')
    if not data.startswith(b'\xff\xd8\xff') or len(data) > 40 * 1024 * 1024:
        raise ApiFail('Photos must be JPEG images.')
    return data


def save_record(body):
    fields = {k: clean(body.get(k, ''), n) for k, n in FIELDS.items()}
    for k in REQUIRED:
        if not fields[k]:
            raise ApiFail('Fill in the fields marked *.')
    rid = str(body.get('id') or '')
    if rid and not ID_RE.match(rid):
        raise ApiFail('Invalid row id.')
    rid = rid or secrets.token_hex(8)

    plan = []  # decode every photo before touching stored data
    photos_in = body.get('photos') or []
    for i in range(SLOTS):
        p = photos_in[i] if i < len(photos_in) and isinstance(photos_in[i], dict) else {}
        if p.get('state') == 'new':
            full = decode_jpeg(p.get('full'))
            xl = decode_jpeg(p.get('xl')) if p.get('xl') else full
            w, h = int(p.get('w') or 0), int(p.get('h') or 0)
            if not (w and h):
                w, h = jpeg_size(full)
            plan.append(('new', full, xl, w, h))
        else:
            plan.append(('keep',) if p.get('state') == 'keep' else ('none',))

    with db_lock:
        rows = load_db()
        idx = next((n for n, r in enumerate(rows) if r.get('id') == rid), None)
        now = now_ms()
        if idx is None:
            created = int(body.get('createdAt') or 0)
            rec = {'id': rid, 'createdAt': created if 946684800000 < created < now + 86400000 else now,
                   'photos': [None] * SLOTS}
        else:
            rec = rows[idx]
        rec.update(fields)
        rec['updatedAt'] = now
        rec['exportedAt'] = int(body.get('exportedAt') or 0) or None
        photos = (list(rec.get('photos') or []) + [None] * SLOTS)[:SLOTS]
        for i, step in enumerate(plan):
            if step[0] == 'keep' and photos[i]:
                continue
            if step[0] == 'new':
                write_bytes(photo_path(rid, i, 'full'), step[1])
                write_bytes(photo_path(rid, i, 'xl'), step[2])
                photos[i] = {'w': step[3], 'h': step[4]}
                continue
            for size in ('full', 'xl'):
                photo_path(rid, i, size).unlink(missing_ok=True)
            photos[i] = None
        rec['photos'] = photos
        if idx is None:
            rows.append(rec)
        else:
            rows[idx] = rec
        save_db(rows)
    return rec


def delete_record(rid):
    if not ID_RE.match(rid):
        raise ApiFail('Invalid row id.')
    with db_lock:
        save_db([r for r in load_db() if r.get('id') != rid])
    for i in range(SLOTS):
        for size in ('full', 'xl'):
            photo_path(rid, i, size).unlink(missing_ok=True)


def mark_exported(ids, ts):
    ids = set(str(x) for x in ids or [])
    with db_lock:
        rows = load_db()
        for r in rows:
            if r.get('id') in ids:
                r['exportedAt'] = int(ts or now_ms())
        save_db(rows)


def in_exports(rel):
    root = EXPORTS.resolve()
    p = (root / str(rel or '')).resolve()
    if p == root or root not in p.parents or p.suffix.lower() != '.xlsx':
        raise ApiFail('Invalid file path.')
    return p


def list_files():
    root = EXPORTS.resolve()
    out = []
    for folder, dirs, files in os.walk(str(root)):
        dirs[:] = [d for d in dirs if d.lower() != 'backups' and not d.startswith('.')]
        for name in files:
            if name.lower().endswith('.xlsx') and not name.startswith(('~$', '.')):
                p = Path(folder) / name
                st = p.stat()
                out.append({'path': p.relative_to(root).as_posix(), 'name': name, 'size': st.st_size,
                            'lastModified': mtime_ms(st)})
    return out


def write_export(rel, data, last_modified, size):
    p = in_exports(rel)
    if not p.is_file():
        raise ApiFail('That file no longer exists.', 404)
    st = p.stat()
    if mtime_ms(st) != int(last_modified) or st.st_size != int(size):
        raise ApiFail('The file was changed outside the app.', 409, 'changed')
    if p.with_name('.~lock.' + p.name + '#').exists():  # LibreOffice keeps this while the file is open
        raise ApiFail('The file is open in LibreOffice - close it there first.', 409, 'locked')
    write_bytes(p, data)
    st = p.stat()
    return {'lastModified': mtime_ms(st), 'size': st.st_size}


def save_output(sub, base, ext, data):
    folder = {'Exports': EXPORTS, 'Backups': BACKUPS}.get(sub)
    if folder is None or ext not in ('.xlsx', '.zip'):
        raise ApiFail('Invalid output.')
    base = re.sub(r'[^\w.\- ]+', '_', base or '').strip(' .')[:80] or 'ACP4U'
    folder.mkdir(parents=True, exist_ok=True)
    name, n = base + ext, 2
    while (folder / name).exists():
        name = '{}_{}{}'.format(base, n, ext)
        n += 1
    write_bytes(folder / name, data)
    return display(folder / name)


def detach_kwargs(log=None):
    kw = {'stdin': subprocess.DEVNULL, 'stdout': log or subprocess.DEVNULL, 'stderr': log or subprocess.DEVNULL}
    if os.name == 'nt':
        kw['creationflags'] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw['start_new_session'] = True
    return kw


def open_folder(sub):
    p = {'Exports': EXPORTS, 'Backups': BACKUPS}.get(sub, HOME)
    p.mkdir(parents=True, exist_ok=True)
    if os.name == 'nt':
        os.startfile(str(p))  # noqa: only exists on Windows
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', str(p)], **detach_kwargs())
    elif shutil.which('xdg-open'):
        subprocess.Popen(['xdg-open', str(p)], **detach_kwargs())
    else:
        raise ApiFail('No file manager found - the folder is ' + display(p))


# ---------------------------------------------------------------- HTTP service

class Handler(BaseHTTPRequestHandler):
    server_version = 'ACP4U/' + VERSION

    def log_message(self, fmt, *args):
        pass

    def send_body(self, code, body, ctype, headers=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        headers = headers or {}
        if 'Cache-Control' not in headers:
            self.send_header('Cache-Control', 'no-store')
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        obj = dict(obj, app='acp4u-parts')
        self.send_body(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')

    def read_body(self, limit):
        n = int(self.headers.get('Content-Length') or 0)
        if n > limit:
            raise ApiFail('Too much data in one request.', 413)
        chunks, left = [], n
        while left > 0:
            chunk = self.rfile.read(min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        return b''.join(chunks)

    def handle_any(self, method):
        global last_request
        last_request = time.time()
        # only this machine, and no DNS-rebinding tricks from web pages
        if (self.headers.get('Host') or '').rsplit(':', 1)[0] not in ('127.0.0.1', 'localhost'):
            return self.send_body(403, b'Forbidden', 'text/plain')
        url = urllib.parse.urlsplit(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if method == 'GET' and url.path in STATIC:
            f = APP_DIR / STATIC[url.path]
            if not f.is_file():
                return self.send_body(404, b'Not found', 'text/plain')
            return self.send_body(200, f.read_bytes(), TYPES[f.suffix], {'Cache-Control': 'no-cache'})
        if not url.path.startswith('/api/'):
            return self.send_body(404, b'Not found', 'text/plain')
        try:
            token = self.headers.get('X-ACP4U-Token') or q.get('t') or ''
            if not (token and secrets.compare_digest(token, self.server.token)):
                raise ApiFail('This window has no app key - open ACP4U Parts from the menu.', 401)
            self.api(method, url.path, q)
        except ApiFail as e:
            self.send_json(e.status, {'ok': False, 'error': e.msg, 'code': e.code})
        except Exception as e:  # keep the service alive, report the problem
            sys.stderr.write('{} {} failed: {!r}\n'.format(method, url.path, e))
            self.send_json(500, {'ok': False, 'error': 'Internal error: {}'.format(e)})

    def do_GET(self):
        self.handle_any('GET')

    def do_POST(self):
        self.handle_any('POST')

    def api(self, method, path, q):
        if method == 'GET' and path == '/api/ping':
            return self.send_json(200, {'ok': True, 'version': VERSION, 'home': display(HOME),
                                        'exports': display(EXPORTS), 'backups': display(BACKUPS)})
        if method == 'GET' and path == '/api/records':
            with db_lock:
                rows = load_db()
            return self.send_json(200, {'ok': True, 'records': rows})
        if method == 'GET' and path == '/api/photo':
            rid, size = q.get('id', ''), ('full' if q.get('s') == 'full' else 'xl')
            i = int(q.get('i') or -1) if (q.get('i') or '').isdigit() else -1
            if not ID_RE.match(rid) or not 0 <= i < SLOTS:
                raise ApiFail('Invalid photo.')
            p = photo_path(rid, i, size)
            if not p.is_file():
                raise ApiFail('Photo not found.', 404)
            return self.send_body(200, p.read_bytes(), 'image/jpeg', {'Cache-Control': 'private, max-age=31536000, immutable'})
        if method == 'GET' and path == '/api/files':
            return self.send_json(200, {'ok': True, 'files': list_files()})
        if method == 'GET' and path == '/api/file':
            p = in_exports(q.get('path'))
            if not p.is_file():
                raise ApiFail('That file no longer exists.', 404)
            st = p.stat()
            return self.send_body(200, p.read_bytes(), 'application/octet-stream',
                                  {'X-Last-Modified': str(mtime_ms(st)), 'X-Size': str(st.st_size)})
        if method != 'POST':
            raise ApiFail('Unknown request.', 404)

        if path == '/api/records':
            body = json.loads(self.read_body(MAX_JSON) or b'{}')
            return self.send_json(200, {'ok': True, 'record': save_record(body)})
        if path == '/api/records/delete':
            delete_record(str(json.loads(self.read_body(4096) or b'{}').get('id') or ''))
            return self.send_json(200, {'ok': True})
        if path == '/api/records/exported':
            body = json.loads(self.read_body(MAX_JSON) or b'{}')
            mark_exported(body.get('ids'), body.get('ts'))
            return self.send_json(200, {'ok': True})
        if path == '/api/save':
            saved = save_output(q.get('sub'), q.get('base'), q.get('ext'), self.read_body(MAX_FILE))
            return self.send_json(200, {'ok': True, 'path': saved})
        if path == '/api/file':
            stat = write_export(q.get('path'), self.read_body(MAX_FILE), q.get('lastModified') or 0, q.get('size') or 0)
            return self.send_json(200, dict(stat, ok=True))
        if path == '/api/open':
            open_folder(str(json.loads(self.read_body(4096) or b'{}').get('sub') or ''))
            return self.send_json(200, {'ok': True})
        if path == '/api/shutdown':
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return self.send_json(200, {'ok': True})
        raise ApiFail('Unknown request.', 404)


def serve(port=None):
    ensure_dirs()
    srv = None
    for p in ([port] if port else range(BASE_PORT, BASE_PORT + 40)):
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', p), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit('ACP4U Parts: no free local port found.')
    srv.daemon_threads = True
    srv.token = get_token()
    STATE_FILE.write_text(json.dumps({'port': srv.server_address[1], 'pid': os.getpid(), 'version': VERSION}))

    def watchdog():
        while time.time() - last_request < IDLE_LIMIT:
            time.sleep(20)
        srv.shutdown()

    threading.Thread(target=watchdog, daemon=True).start()
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
        try:
            if json.loads(STATE_FILE.read_text()).get('pid') == os.getpid():
                STATE_FILE.unlink()
        except (OSError, ValueError):
            pass


# ---------------------------------------------------------------- launcher

def call(port, token, path, data=None, timeout=3):
    req = urllib.request.Request('http://127.0.0.1:{}{}'.format(port, path), data=data,
                                 headers={'X-ACP4U-Token': token}, method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def running_port(token):
    try:
        port = int(json.loads(STATE_FILE.read_text()).get('port') or 0)
        if port and call(port, token, '/api/ping').get('ok'):
            return port
    except (OSError, ValueError):
        pass
    return None


def start_service(token):
    ensure_dirs()
    with open(str(LOG_FILE), 'ab') as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve'], cwd=str(APP_DIR), **detach_kwargs(log))
    deadline = time.time() + 15
    while time.time() < deadline:
        time.sleep(0.25)
        port = running_port(token)
        if port:
            return port
    sys.exit('ACP4U Parts: the service did not start - see ' + display(LOG_FILE))


def flatpak_has(app_id):
    try:
        return subprocess.run(['flatpak', 'info', app_id], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def open_window(url):
    custom = os.environ.get('ACP4U_BROWSER')
    if custom:
        subprocess.Popen(shlex.split(custom) + [url], **detach_kwargs())
        return 'ACP4U_BROWSER'
    if sys.platform.startswith('linux'):
        app_flags = ['--app=' + url, '--class=acp4u-parts', '--window-size=1320,880']
        for name in CHROMIUM:
            exe = shutil.which(name)
            if exe:
                subprocess.Popen([exe] + app_flags, **detach_kwargs())
                return name
        if shutil.which('flatpak'):
            for app_id in FLATPAK:
                if flatpak_has(app_id):
                    subprocess.Popen(['flatpak', 'run', app_id] + app_flags, **detach_kwargs())
                    return app_id
        if shutil.which('xdg-open'):
            subprocess.Popen(['xdg-open', url], **detach_kwargs())
            return 'default browser'
    import webbrowser
    webbrowser.open(url)
    return 'default browser'


def stop_service():
    token = get_token()
    port = running_port(token)
    if not port:
        return False
    try:
        call(port, token, '/api/shutdown', data=b'{}')
    except OSError:
        pass
    for _ in range(40):
        if not running_port(token):
            break
        time.sleep(0.25)
    return True


def update():
    url = 'https://raw.githubusercontent.com/{}/main/install.sh'.format(REPO)
    print('Downloading the installer from', url)
    with urllib.request.urlopen(url, timeout=60) as r:
        script = r.read()
    with tempfile.NamedTemporaryFile('wb', suffix='.sh', delete=False) as f:
        f.write(script)
    try:
        return subprocess.call(['bash', f.name])
    finally:
        os.unlink(f.name)


def uninstall(assume_yes):
    if not assume_yes:
        answer = input('Remove the ACP4U Parts program? Your data in {} is kept. [y/N] '.format(display(HOME)))
        if answer.strip().lower() not in ('y', 'yes'):
            print('Nothing removed.')
            return
    stop_service()
    desktop_dir = Path.home() / 'Desktop'
    try:
        out = subprocess.run(['xdg-user-dir', 'DESKTOP'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            desktop_dir = Path(out.stdout.decode().strip())
    except (OSError, subprocess.SubprocessError):
        pass
    for f in (LAUNCHER, DESKTOP_FILE, ICON_FILE, desktop_dir / 'acp4u-parts.desktop'):
        try:
            f.unlink()
        except OSError:
            pass
    shutil.rmtree(str(INSTALL_DIR), ignore_errors=True)
    print('ACP4U Parts was removed. Your rows, photos and Excel files are still in', display(HOME))


def main():
    ap = argparse.ArgumentParser(prog='acp4u-parts', description='ACP4U Parts - customer parts requests with Excel export.')
    ap.add_argument('--status', action='store_true', help='show where the data lives and whether the service runs')
    ap.add_argument('--stop', action='store_true', help='stop the background service')
    ap.add_argument('--no-browser', action='store_true', help='start the service and only print the address')
    ap.add_argument('--update', action='store_true', help='install the latest version from GitHub')
    ap.add_argument('--uninstall', action='store_true', help='remove the program (your data stays)')
    ap.add_argument('-y', '--yes', action='store_true', help='do not ask before uninstalling')
    ap.add_argument('--version', action='version', version='ACP4U Parts ' + VERSION)
    ap.add_argument('--serve', action='store_true', help=argparse.SUPPRESS)
    ap.add_argument('--port', type=int, help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a.serve:
        return serve(a.port)
    if a.stop:
        print('ACP4U Parts service stopped.' if stop_service() else 'ACP4U Parts service was not running.')
        return
    if a.update:
        stop_service()
        sys.exit(update())
    if a.uninstall:
        return uninstall(a.yes)
    token = get_token()
    if a.status:
        port = running_port(token)
        print('ACP4U Parts', VERSION)
        print('  program :', display(APP_DIR))
        print('  data    :', display(HOME), '(rows & photos in data/, Excel files in Exports/, backups in Backups/)')
        print('  service :', 'running on http://127.0.0.1:{}'.format(port) if port else 'not running')
        return
    port = running_port(token) or start_service(token)
    url = 'http://127.0.0.1:{}/#t={}'.format(port, token)
    if a.no_browser:
        print(url)
        return
    how = open_window(url)
    print('ACP4U Parts is open ({}). Data folder: {}'.format(how, display(HOME)))


if __name__ == '__main__':
    main()
