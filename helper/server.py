#!/usr/bin/env python3
"""Local server for the 3DX world editor.

Serves the editor page and reads world files from the game's Worlds folder,
so it works in any browser (Brave included). Standard library only.

    python server.py            # or double-click Start Editor.bat

The page opens by itself. Press Ctrl+C in the terminal window to stop.
"""
import collections
import http.server
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paths  # noqa: E402  (where Worlds and the game are; Settings → General can change them)

VERSION = "0.1 beta"
# Where the beta's editor page lives (GitHub Pages). Only that page and this PC
# may talk to the helper.
SITE = os.environ.get("HORNY_BUILDER_SITE") or "https://ToxicLizard99.github.io/the-horny-builder/"  # env: for testing
SITE_ORIGINS = {urllib.parse.urlsplit(SITE)._replace(path="").geturl().lower()}  # browsers send it in lowercase
# The developer's copy has the page next to it; the beta's helper fetches it from SITE.
LOCAL_PAGE = (HERE / "web" / "index.html").is_file()
PAGE_FILES = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8",
              "style.css": "text/css; charset=utf-8"}
_page_cache = {}  # name → (fetched at, bytes): fresh from GitHub each minute, last copy if offline


def page_file(name):
    import urllib.request
    got = _page_cache.get(name)
    if got and time.time() - got[0] < 60:
        return got[1], PAGE_FILES[name]
    try:
        req = urllib.request.Request(SITE + name, headers={"Cache-Control": "no-cache", "User-Agent": "TheHornyBuilder-helper"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = r.read()
        _page_cache[name] = (time.time(), data)
    except OSError:
        if not got:
            raise
        data = got[1]  # offline: keep using the copy fetched earlier this session
    return data, PAGE_FILES[name]
# AI connections come in a later version: the beta ships without mcp_server.py,
# and the editor shows its AI button and Settings page as "coming soon".
AI_AVAILABLE = (HERE / "mcp_server.py").exists()
WORLDS = paths.worlds_folder()[0]
# real game models and textures, made by extract_models.py (kept off OneDrive)
CACHE = (Path(os.environ.get("LOCALAPPDATA", HERE)) / "3DX Editor" / "cache").resolve()
TYPES = {".glb": "model/gltf-binary", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png"}
FIRST_PORT = 8710


ABSOLUTE = re.compile(r"^([A-Za-z]:[\\/]|[\\/]{2})")


def world_path(rel):
    """A room file: relative paths are inside the Worlds folder; full paths
    ("C:/Users/…/Party.world") can be anywhere, since the game opens rooms from
    any folder. Only .world files, never anything else."""
    if not rel:
        return None
    p = Path(rel).resolve() if ABSOLUTE.match(rel) else (WORLDS / rel).resolve()
    if p.suffix.lower() != ".world":
        return None
    if not ABSOLUTE.match(rel) and WORLDS not in p.parents:
        return None  # "../" tricks out of the Worlds folder
    return p


def page_path(p):
    """How the page names a room: relative inside the Worlds folder, full path elsewhere."""
    p = Path(p).resolve()
    return p.relative_to(WORLDS).as_posix() if WORLDS in p.parents else p.as_posix()


def list_rooms(folder):
    """Every .world file in a folder and its subfolders (for the room list)."""
    out = []
    for f in sorted(folder.rglob("*.world"), key=lambda f: str(f).lower()):
        try:
            st = f.stat()
        except OSError:
            continue
        out.append({"path": page_path(f), "size": st.st_size, "mtime": str(st.st_mtime_ns)})
        if len(out) >= 3000:
            break
    return out


_catalog = {"key": None, "data": None}


def catalog():
    """Every object name and material used across all worlds, most used first."""
    files = sorted(WORLDS.rglob("*.world"))
    key = tuple((str(f), f.stat().st_mtime_ns) for f in files)
    if _catalog["key"] == key:
        return _catalog["data"]
    names, mats = collections.Counter(), collections.Counter()

    def walk(objs):
        for o in objs:
            if isinstance(o.get("objects"), list):
                walk(o["objects"])
            else:
                names[o.get("n")] += 1
                if o.get("m"):
                    mats[o["m"]] += 1

    for f in files:
        try:
            walk(json.loads(f.read_text(encoding="utf-8-sig")).get("objects", []))
        except (OSError, ValueError):
            continue
    data = {"names": [n for n, _ in names.most_common() if n],
            "materials": [m for m, _ in mats.most_common()]}
    _catalog.update(key=key, data=data)
    return data


def save_world(rel, text, create):
    """Write a world file. The text must be a valid world; the write is atomic."""
    p = world_path(rel)
    if not p:
        return 400, {"error": "Rooms are saved as .world files"}
    if create and p.exists():
        return 409, {"error": "exists"}
    try:
        world = json.loads(text)
    except ValueError as err:
        return 400, {"error": f"Not valid JSON: {err}"}
    if not isinstance(world, dict) or not isinstance(world.get("objects"), list):
        return 400, {"error": "Not a world (no objects list)"}
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".saving")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)  # swap in one step, so a crash can't leave half a file
    return 200, {"path": page_path(p), "mtime": str(p.stat().st_mtime_ns)}


PALETTE = CACHE.parent / "palette.json"   # the colour picker's saved colours (not on OneDrive)
HEX = re.compile(r"#[0-9a-f]{6}")


def read_palette():
    try:
        data = json.loads(PALETTE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    out = {k: [c for c in data.get(k, []) if isinstance(c, str) and HEX.fullmatch(c)] for k in ("mine", "recent", "game")}
    out["game_imported"] = data.get("game_imported")
    return out


def write_palette(data):
    PALETTE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PALETTE.with_name(PALETTE.name + ".saving")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, PALETTE)


def game_palette():
    """The colour palette from the game's own colour picker. The game keeps it
    in its saved settings (registry, HKCU\\Software\\SexGameDevil\\3DXChat,
    "MyPaletteColors_h…" = "1:255,255,255|2:211,211,211|…"). Read only."""
    try:
        import winreg
    except ImportError:
        raise LookupError("Importing the game's palette only works on Windows.")
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\SexGameDevil\3DXChat")
    except OSError:
        raise LookupError("3DXChat's settings weren't found on this PC (has the game been run here?).")
    with key:
        i, raw = 0, None
        while raw is None:
            try:
                name, value, _ = winreg.EnumValue(key, i)
            except OSError:
                break
            if name.startswith("MyPaletteColors"):
                raw = value
            i += 1
    if raw is None:
        raise LookupError("The game has no saved palette yet (open its colour picker in game once).")
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    slots = []
    for part in text.strip("\0").split("|"):
        m = re.fullmatch(r"\s*(\d+)\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*", part)
        if m:
            slots.append((int(m[1]), "#" + "".join(f"{min(255, int(v)):02x}" for v in m.groups()[1:])))
    if not slots:
        raise LookupError("The game's palette couldn't be read.")
    return [c for _, c in sorted(slots)]


class Looks:
    """Screenshots for the AI's look tool. The MCP server posts a request and
    waits; the open editor page is always waiting for the next request (long
    polling, so it answers at once even in a background tab), takes the
    picture and posts it back. A page claims a request before working on it:
    a reloaded or closed tab leaves its old wait behind on the server, and
    that one mustn't swallow the request."""
    cond = threading.Condition()
    waiting = None      # the current request, until answered
    claimed = False     # a page has taken it
    results = {}        # request id → the page's answer
    last_seen = 0.0     # when a page last asked for work
    pages = 0           # waits open right now (some may belong to closed tabs)

    @classmethod
    def next(cls, wait=20):
        with cls.cond:
            cls.pages += 1
            try:
                end = time.time() + wait
                while (cls.waiting is None or cls.claimed) and time.time() < end:
                    cls.last_seen = time.time()
                    cls.cond.wait(max(0.0, end - time.time()))
                cls.last_seen = time.time()
                return None if cls.claimed else cls.waiting
            finally:
                cls.pages -= 1

    @classmethod
    def claim(cls, rid):
        with cls.cond:
            if cls.waiting and cls.waiting["id"] == rid and not cls.claimed:
                cls.claimed = True
                cls.cond.notify_all()
                return True
            return False

    @classmethod
    def ask(cls, req, wait=60):
        with cls.cond:
            if not cls.pages and time.time() - cls.last_seen > 5:
                return 503, {"error": "The editor isn't open. Ask the user to start it (Start Editor.bat) "
                                      "and keep its browser tab open, then try again."}
            if cls.waiting is not None:
                return 409, {"error": "The editor is busy with another picture; try again in a moment."}
            req["id"] = rid = uuid.uuid4().hex
            cls.waiting, cls.claimed = req, False
            cls.cond.notify_all()
            try:
                end = time.time() + 10  # time for a live tab to take it
                while not cls.claimed and time.time() < end:
                    cls.cond.wait(max(0.0, end - time.time()))
                if not cls.claimed:
                    return 503, {"error": "The editor's tab didn't respond. It may be asleep: ask the user to "
                                          "click on the editor tab (or reload it), then try again."}
                end = time.time() + wait
                while rid not in cls.results and time.time() < end:
                    cls.cond.wait(max(0.0, end - time.time()))
                got = cls.results.pop(rid, None)
            finally:
                cls.waiting, cls.claimed = None, False
                cls.cond.notify_all()
        if got is None:
            return 504, {"error": "The editor didn't finish the picture in time (is it very busy?)."}
        return 200, got

    @classmethod
    def done(cls, answer):
        with cls.cond:
            cls.results[answer.get("id")] = answer
            cls.cond.notify_all()


# ---------------------------------------------------------------- Settings
def settings_info():
    worlds, worlds_auto = paths.worlds_folder()
    game, game_auto = paths.game_folder()
    guess = paths.worlds_guess()
    return {"version": VERSION, "worlds": str(WORLDS), "worlds_set": paths.worlds_chosen() is not None,
            "worlds_guess": str(guess) if guess else None,
            "game": str(game) if game else None, "game_auto": game_auto,
            "ai_available": AI_AVAILABLE, "ai": ai_status() if AI_AVAILABLE else None}


def ask_folder(title, start, kind="folder", name=""):
    """A Windows picker on top of the browser: a folder, a room file to open, or
    where to save one. None if cancelled."""
    import tkinter
    from tkinter import filedialog
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)  # so the window shows above the browser
    root.update()
    root.lift()
    root.focus_force()
    start = start if start and Path(start).is_dir() else str(Path.home())
    rooms = [("3DXChat rooms", "*.world"), ("All files", "*.*")]
    try:
        if kind == "file":
            got = filedialog.askopenfilename(title=title, initialdir=start, filetypes=rooms, parent=root)
        elif kind == "save":
            got = filedialog.asksaveasfilename(title=title, initialdir=start, initialfile=name, defaultextension=".world",
                                               filetypes=rooms, confirmoverwrite=True, parent=root)
        else:
            got = filedialog.askdirectory(title=title, initialdir=start, mustexist=True, parent=root)
    finally:
        root.destroy()
    return got or None


def pick(kind, start, name):
    """The room list's "Open a file…", "Other folder…" and "Save somewhere else…"."""
    if not _dialog.acquire(blocking=False):
        return 409, {"error": "A Windows file window is already open (it may be behind the browser)."}
    try:
        title = {"file": "Open a 3DXChat room", "save": "Save the room as", "folder": "Pick a folder with rooms"}[kind]
        got = ask_folder(title, start or str(WORLDS), kind, name)
    finally:
        _dialog.release()
    if not got:
        return 200, {"path": None}
    p = Path(got)
    if kind == "save" and p.suffix.lower() != ".world":
        p = p.with_suffix(".world")
    if kind == "file" and p.suffix.lower() != ".world":
        return 400, {"error": "That isn't a .world room file."}
    if kind == "folder":
        return 200, {"path": p.resolve().as_posix()}
    return 200, {"path": page_path(p), "exists": p.exists()}


_dialog = threading.Lock()  # one folder picker at a time


def change_folder(which, action):
    global WORLDS
    if action == "auto":
        paths.save_choice(which, None)
    elif action == "guess" and which == "worlds":  # "Use this folder" on the one the editor found
        guess = paths.worlds_guess()
        if not guess:
            return 404, {"error": "No Worlds folder was found; pick it with Change…"}
        paths.save_choice("worlds", str(guess))
    else:
        if not _dialog.acquire(blocking=False):
            return 409, {"error": "A folder window is already open."}
        try:
            current = WORLDS if which == "worlds" else paths.game_folder()[0]
            got = ask_folder("Pick the Worlds folder (3DXChat's Documents\\3DXChat\\Worlds)" if which == "worlds"
                             else "Pick the 3DXChat game folder", str(current) if current else None)
        finally:
            _dialog.release()
        if not got:
            return 200, settings_info()
        p = Path(got)
        if which == "game" and not paths.game_data(p):
            return 400, {"error": f"{p} doesn't look like the 3DXChat game folder (no 3DXChat_Data inside)."}
        if which == "worlds" and not p.is_dir():
            return 400, {"error": f"{p} isn't a folder."}
        paths.save_choice(which, str(p.resolve()))
    if which == "worlds":
        WORLDS = paths.worlds_folder()[0]
    return 200, settings_info()


# ---------------------------------------------------------------- AI apps
# The MCP server, run by the AI app with the editor's own Python.
MCP_COMMAND = str(Path(sys.executable).resolve())
MCP_SCRIPT = str(HERE / "mcp_server.py")
MCP_NAME = "3dx-builder"


def claude_app_config():
    """The Claude desktop app's config file: the Microsoft Store build keeps it in
    its package folder, the regular installer in %APPDATA%\\Claude. None if Claude
    isn't installed."""
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    for pkg in sorted((local / "Packages").glob("Claude_*")):
        return pkg / "LocalCache" / "Roaming" / "Claude" / "claude_desktop_config.json"
    roaming = Path(os.environ.get("APPDATA", "")) / "Claude"
    return roaming / "claude_desktop_config.json" if roaming.is_dir() else None


def read_json(p):
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None  # there but unreadable: never overwrite it


def ai_status():
    cfg = claude_app_config()
    app = None
    if cfg:
        data = read_json(cfg)
        app = {"installed": True, "connected": bool(data and MCP_NAME in (data.get("mcpServers") or {})),
               "readable": data is not None, "file": str(cfg)}
    code = read_json(Path.home() / ".claude.json")
    return {"claude_app": app or {"installed": False, "connected": False},
            "claude_code": bool(code and MCP_NAME in (code.get("mcpServers") or {})),
            "command": MCP_COMMAND, "script": MCP_SCRIPT, "name": MCP_NAME}


def claude_app_connect(on):
    """Add (or remove) the editor in the Claude app's MCP servers, keeping
    everything else in that file as it was."""
    cfg = claude_app_config()
    if not cfg:
        return 404, {"error": "The Claude desktop app isn't installed on this PC."}
    data = read_json(cfg)
    if data is None:
        return 409, {"error": f"Claude's config file couldn't be read ({cfg}); not touching it."}
    servers = data.setdefault("mcpServers", {})
    if on:
        servers[MCP_NAME] = {"command": MCP_COMMAND, "args": [MCP_SCRIPT]}
    else:
        servers.pop(MCP_NAME, None)
    cfg.parent.mkdir(parents=True, exist_ok=True)
    tmp = cfg.with_name(cfg.name + ".saving")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, cfg)
    return 200, ai_status()


class Activity:
    """What AI assistants did through the MCP server, for the editor's AI
    button. The MCP server reports each tool call's start and end; kept in
    memory only."""
    lock = threading.Lock()
    items = collections.deque(maxlen=30)  # finished actions, newest last
    busy = {}                             # call id → start time
    app = None                            # the AI app last seen

    @classmethod
    def note(cls, body):
        with cls.lock:
            cls.app = body.get("app") or cls.app
            cid = body.get("call")
            if body.get("phase") == "start":
                cls.busy[cid] = time.time()
                return
            cls.busy.pop(cid, None)
            cls.items.append({"t": time.time(), "text": str(body.get("text", ""))[:200],
                              "room": body.get("room"), "ok": bool(body.get("ok", True))})

    @classmethod
    def state(cls):
        with cls.lock:
            now = time.time()
            for cid, t in list(cls.busy.items()):
                if now - t > 120:  # a call that never reported back
                    del cls.busy[cid]
            return {"now": now, "app": cls.app, "busy": bool(cls.busy), "items": list(cls.items)}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE / "web"), **kwargs)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        rel = query.get("path", [""])[0]

        if url.path == "/api/worlds":
            folder = query.get("folder", [""])[0]
            if folder:  # any other folder the user opened in the room list
                f = Path(folder)
                if not ABSOLUTE.match(folder) or not f.is_dir():
                    return self.send_json({"error": "That folder isn't there any more."}, 404)
                return self.send_json({"root": f.resolve().as_posix(), "worlds": list_rooms(f)})
            if paths.worlds_chosen() is None:  # no folder picked in Settings yet: no rooms to list
                return self.send_json({"root": None, "worlds": [], "needs_folder": True})
            return self.send_json({"root": str(WORLDS), "worlds": list_rooms(WORLDS)})

        if url.path.startswith("/cache/"):
            p = (CACHE / urllib.parse.unquote(url.path[len("/cache/"):])).resolve()
            if CACHE not in p.parents or not p.is_file() or p.suffix.lower() not in TYPES:
                return self.send_json({"error": "not in cache"}, 404)
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", TYPES[p.suffix.lower()])
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if url.path == "/api/catalog":
            return self.send_json(catalog())

        if url.path == "/api/hello":  # lets the editor page (and the MCP server) find this helper
            return self.send_json({"app": "3dx-editor", "version": VERSION, "worlds": str(WORLDS)})

        if url.path == "/api/ai/activity":
            return self.send_json(Activity.state())

        if url.path == "/api/palette":
            return self.send_json(read_palette())

        if url.path == "/api/settings/info":
            return self.send_json(settings_info())

        if url.path == "/api/look/next":
            return self.send_json(Looks.next() or {})

        if url.path == "/api/mtime":
            p = world_path(rel)
            if not p or not p.exists():
                return self.send_json({"error": "no such world"}, 404)
            return self.send_json({"mtime": str(p.stat().st_mtime_ns)})

        if url.path == "/api/world":
            p = world_path(rel)
            if not p or not p.exists():
                return self.send_json({"error": "no such world"}, 404)
            try:
                data = p.read_bytes()
                mtime = p.stat().st_mtime_ns
            except OSError as err:
                return self.send_json({"error": str(err)}, 500)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Mtime", str(mtime))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        if url.path == "/":
            self.path = "/index.html"
            url = urllib.parse.urlsplit(self.path)
        if not LOCAL_PAGE and url.path.lstrip("/") in PAGE_FILES:
            return self.send_page(url.path.lstrip("/"))
        super().do_GET()

    def send_page(self, name):
        """The beta: the editor page lives on GitHub Pages. The helper fetches it
        from there and hands it out on this PC's own address, so the page and the
        helper share one address and browsers don't block them (Brave refuses
        websites that reach into localhost)."""
        try:
            data, kind = page_file(name)
        except OSError as err:
            body = (f"<h2>The Horny Builder</h2><p>The editor page couldn't be fetched from GitHub ({err}). "
                    f"Check your internet connection, then reload this page.</p>").encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        length = int(self.headers.get("Content-Length", 0))
        # Only this editor's own page may change things: rooms can now be saved
        # anywhere, so a random website must not be able to post here.
        if self.headers.get("Origin") and not self.allowed_origin():
            return self.send_json({"error": "forbidden"}, 403)
        if url.path == "/api/perf":
            # performance numbers from the page, for diagnosing lag (last ~2000 lines kept)
            line = self.rfile.read(min(length, 10000)).decode("utf-8", "replace").replace("\n", " ")
            log = CACHE.parent / "perf.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            lines = log.read_text(encoding="utf-8").splitlines()[-1999:] if log.exists() else []
            lines.append(time.strftime("%H:%M:%S ") + line)
            log.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return self.send_json({"ok": True})
        if url.path.startswith("/api/settings/"):
            try:
                body = json.loads(self.rfile.read(min(length, 10000)).decode("utf-8") or "{}")
            except ValueError:
                return self.send_json({"error": "bad request"}, 400)
            which = body.get("which")
            if url.path == "/api/settings/folder" and which in ("worlds", "game"):
                status, result = change_folder(which, body.get("action"))
                return self.send_json(result, status)
            if url.path == "/api/settings/open" and which in ("worlds", "game"):
                folder = WORLDS if which == "worlds" else paths.game_folder()[0]
                if folder and Path(folder).is_dir():
                    os.startfile(folder)
                    return self.send_json({"ok": True})
                return self.send_json({"error": "Folder not found."}, 404)
            if url.path == "/api/settings/pick" and body.get("kind") in ("file", "folder", "save"):
                start = body.get("start") or ""
                status, result = pick(body["kind"], start if ABSOLUTE.match(start) else str(WORLDS), str(body.get("name") or ""))
                return self.send_json(result, status)
            if url.path == "/api/settings/claude-app" and not AI_AVAILABLE:
                return self.send_json({"error": "AI connections come in a later version."}, 404)
            if url.path == "/api/settings/claude-app":
                status, result = claude_app_connect(bool(body.get("connect")))
                return self.send_json(result, status)
            return self.send_json({"error": "unknown"}, 404)
        if url.path == "/api/palette/import-game":
            try:
                colours = game_palette()
            except LookupError as err:
                return self.send_json({"error": str(err)}, 404)
            data = read_palette()
            data.update(game=colours, game_imported=time.time())
            write_palette(data)
            return self.send_json(data)
        if url.path == "/api/palette":  # the user's own lists; the game's import is kept
            try:
                body = json.loads(self.rfile.read(min(length, 100000)).decode("utf-8"))
            except ValueError:
                return self.send_json({"error": "bad request"}, 400)
            data = read_palette()
            for k, limit in (("mine", 200), ("recent", 12)):
                if isinstance(body.get(k), list):
                    data[k] = [c for c in body[k] if isinstance(c, str) and HEX.fullmatch(c)][:limit]
            write_palette(data)
            return self.send_json(data)
        if url.path == "/api/ai/activity":
            try:
                Activity.note(json.loads(self.rfile.read(min(length, 10000)).decode("utf-8")))
            except ValueError:
                return self.send_json({"error": "bad request"}, 400)
            return self.send_json({"ok": True})
        if url.path in ("/api/look", "/api/look/claim", "/api/look/done"):
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except ValueError:
                return self.send_json({"error": "bad request"}, 400)
            if url.path == "/api/look/claim":
                return self.send_json({"ok": Looks.claim(body.get("id"))})
            if url.path == "/api/look/done":
                Looks.done(body)
                return self.send_json({"ok": True})
            status, result = Looks.ask(body)
            return self.send_json(result, status)
        if url.path != "/api/save":
            return self.send_json({"error": "unknown"}, 404)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return self.send_json({"error": "bad request"}, 400)
        status, result = save_world(body.get("path", ""), body.get("text", ""), bool(body.get("create")))
        return self.send_json(result, status)

    def allowed_origin(self):
        """The editor page calling from GitHub Pages (or from this PC). Any other
        website gets no answer it can read and can't change anything."""
        origin = self.headers.get("Origin")
        if not origin:
            return None
        if origin.lower() in SITE_ORIGINS or urllib.parse.urlsplit(origin).hostname in ("localhost", "127.0.0.1"):
            return origin
        return None

    def do_OPTIONS(self):
        # the browser asks first before a website may talk to this PC
        origin = self.allowed_origin()
        self.send_response(204 if origin else 403)
        if origin:
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def end_headers(self):
        # The page is tiny and changes while we build it, so never cache it.
        self.send_header("Cache-Control", "no-store")
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Expose-Headers", "X-Mtime")
            self.send_header("Vary", "Origin")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # keep the terminal quiet


def free_port(start):
    for port in range(start, start + 20):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit("No free port found")


if __name__ == "__main__":
    port = free_port(FIRST_PORT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # The page comes from next to this file (developer) or from GitHub through
    # the helper (beta); either way it opens on this PC's own address.
    url = f"http://localhost:{port}/"
    print("The Horny Builder helper is running. Keep this window open while you build.")
    print(f"Worlds: {WORLDS if paths.worlds_chosen() else 'not picked yet (the editor asks)'}")
    print(f"Editor: {url}   (close this window, or Ctrl+C, to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
