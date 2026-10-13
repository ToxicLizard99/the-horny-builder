"""Where the editor's folders are: the game's Worlds folder and the 3DXChat
game itself. Found automatically; a choice made in Settings → General is kept
in %LOCALAPPDATA%\\3DX Editor\\config.json and wins over the guess.

Used by server.py, worldkit.py (so the MCP server too) and extract_models.py.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("LOCALAPPDATA", HERE)) / "3DX Editor"
CONFIG = DATA / "config.json"


def _config() -> dict:
    try:
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_choice(key: str, value: str | None):
    """Remember (or with None, forget) a folder the user picked."""
    data = _config()
    if value is None:
        data.pop(key, None)
    else:
        data[key] = value
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_name(CONFIG.name + ".saving")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, CONFIG)


def _documents() -> list[Path]:
    home = Path.home()
    return [home / "OneDrive" / "Documents", home / "Documents"]


def worlds_guess() -> Path | None:
    """The game keeps rooms in Documents\\3DXChat\\Worlds; the editor usually sits next to it."""
    for p in [HERE.parent / "Worlds", *(d / "3DXChat" / "Worlds" for d in _documents())]:
        if p.is_dir():
            return p.resolve()
    return None


def worlds_chosen() -> Path | None:
    """The Worlds folder the user picked in Settings, if any. The editor's room
    list stays locked until there is one (the guess is only offered there)."""
    picked = _config().get("worlds")
    return Path(picked).resolve() if picked and Path(picked).is_dir() else None


def worlds_folder() -> tuple[Path, bool]:
    """(the Worlds folder, whether it was found automatically)."""
    picked = _config().get("worlds")
    if picked and Path(picked).is_dir():
        return Path(picked).resolve(), False
    guess = worlds_guess()
    return (guess or (HERE.parent / "Worlds").resolve()), True


def game_data(folder: Path) -> Path | None:
    """3DXChat_Data inside a game folder, however deep the user pointed."""
    for p in (folder, folder / "3DXChat_Data", folder / "Game" / "3DXChat_Data"):
        if p.name == "3DXChat_Data" and (p / "globalgamemanagers").is_file():
            return p
    return None


def game_guess() -> Path | None:
    home = Path.home()
    roots = [home / "Downloads" / "3DXChat", home / "Desktop" / "3DXChat", Path("C:/3DXChat"),
             Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "3DXChat",
             Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)")) / "3DXChat"]
    for r in roots:
        if game_data(r):
            return r
    return None


def game_folder() -> tuple[Path | None, bool]:
    """(the 3DXChat game folder or None, whether it was found automatically)."""
    picked = _config().get("game")
    if picked and game_data(Path(picked)):
        return Path(picked), False
    return game_guess(), True
