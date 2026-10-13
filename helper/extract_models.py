"""Reads 3DXChat's object models and materials into a local cache for the editor.

Run with the editor's own Python (it needs UnityPy, installed there):
    "%LOCALAPPDATA%\\3DX Editor\\venv\\Scripts\\python.exe" extract_models.py [path to 3DXChat_Data]

Everything is written to %LOCALAPPDATA%\\3DX Editor\\cache and stays on this PC.
Run it again after a game update.
"""
import io
import json
import os
import re
import struct
import sys
import time
from pathlib import Path

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import game_data, game_folder, save_choice  # noqa: E402  (Settings → General can change it)

_game = game_folder()[0]
GAME_DEFAULT = (game_data(_game) if _game else None) or Path.home() / "Downloads" / "3DXChat" / "Game" / "3DXChat_Data"
CACHE = Path(os.environ["LOCALAPPDATA"]) / "3DX Editor" / "cache"
FILES = ["globalgamemanagers", "globalgamemanagers.assets", "resources.assets", "resources.assets.resS",
         "resources.resource", "Resources/unity default resources", "Resources/unity_builtin_extra"]
MODEL_TEX = 512    # textures on props (seen at a distance)
WALL_TEX = 1024    # wall and floor materials (seen up close)
MESH_PARTS = {"Transform", "MeshFilter", "MeshRenderer", "SkinnedMeshRenderer", "LODGroup", "Light"}
SKY_FACE = 512   # pixels per side of the sky pictures
LIGHT_TYPES = {0: "spot", 1: "directional", 2: "point", 3: "area"}


def safe(name):
    return re.sub(r"[^a-z0-9_.-]+", "_", name.lower())


# ------------------------------------------------------------------ unity helpers
def components(go):
    """The parts of a GameObject we can read. Game scripts (MonoBehaviour) can't
    be read without the game's code, and aren't needed."""
    out = {}
    for c in go.m_Component:
        ptr = c.component if hasattr(c, "component") else c
        try:
            r = ptr.deref()
        except Exception:
            continue
        if r.type.name in MESH_PARTS and r.type.name not in out:
            try:
                out[r.type.name] = r.read()
            except Exception:
                pass
    return out


def trs(t):
    p, q, s = t.m_LocalPosition, t.m_LocalRotation, t.m_LocalScale
    x, y, z, w = q.x, q.y, q.z, q.w
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * np.array([s.x, s.y, s.z])
    m[:3, 3] = [p.x, p.y, p.z]
    return m


def children(t):
    for ch in t.m_Children:
        try:
            yield ch.read()
        except Exception:
            continue


def lod_sets(root_t):
    """Which renderers belong to the detail levels of the prefab's LOD groups:
    (all of them, the full-detail ones, the farthest ones). Renderers outside
    any LOD group always show."""
    every, near, far = set(), set(), set()
    stack = [root_t]
    while stack:
        t = stack.pop()
        parts = components(t.m_GameObject.read())
        lg = parts.get("LODGroup")
        if lg is not None:
            levels = [{r.renderer.path_id for r in lod.renderers if r.renderer.path_id} for lod in lg.m_LODs]
            levels = [lv for lv in levels if lv]
            if levels:
                every.update(*levels)
                near.update(levels[0])
                far.update(levels[-1])
        stack.extend(children(t))
    return every, near, far


# ------------------------------------------------------------------ materials and textures
def unpack_normal(img):
    """Unity packs normal maps with the sideways direction in alpha and the
    up-down direction in green (red stays full). Rebuild a standard RGB normal map."""
    rgba = np.asarray(img.convert("RGBA"), dtype=np.float32) / 255.0
    if rgba[..., 0].mean() < 0.9:  # already a plain normal map
        return img.convert("RGB")
    x = rgba[..., 3] * 2 - 1
    y = rgba[..., 1] * 2 - 1
    z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
    out = np.stack([x, y, z], axis=-1) * 0.5 + 0.5
    from PIL import Image
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGB")


CUTOUT_SHADERS = ("cutout", "leaves", "leaf", "grass", "speedtree", "billboard", "hair", "foliage",
                  "placeholder")  # the game's editor-only icons (lamps, spawn point)


def alpha_mode(shader, mat):
    """How the game draws this material's see-through parts: "mask" (cut-out),
    "blend" (fades) or None (solid). Most props use Standard in Opaque mode with
    smoothness kept in the texture's alpha, so alpha alone means nothing."""
    floats = dict(mat.m_SavedProperties.m_Floats)
    kw = getattr(mat, "m_ShaderKeywords", None) or " ".join(getattr(mat, "m_ValidKeywords", None) or [])
    queue = getattr(mat, "m_CustomRenderQueue", -1)
    mode = floats.get("_Mode")
    s = (shader or "").lower()
    if mode in (2.0, 3.0) or "_ALPHABLEND_ON" in kw or "_ALPHAPREMULTIPLY_ON" in kw or "transparent" in s \
            or ("glass" in s and "opaque" not in s):
        return "blend"
    if mode == 1.0 or "_ALPHATEST_ON" in kw or 2450 <= queue < 3000 or any(w in s for w in CUTOUT_SHADERS):
        return "mask"
    return None


class Library:
    def __init__(self):
        self.textures = {}   # texture path id -> (bytes, mime, has_alpha) or None
        self.failed = 0

    def texture(self, ptr, size=MODEL_TEX, opaque=False, normal=False):
        """A texture as (bytes, mime, has_alpha, original [w, h], PIL image), at most `size` pixels across.
        opaque: the alpha channel holds shininess, not see-through parts (the game's
        wall materials), so it is dropped and the picture saved as a compact JPEG."""
        pid = ptr.path_id
        if not pid:
            return None
        key = (pid, size, opaque, normal)
        if key not in self.textures:
            self.textures[key] = None
            try:
                img = ptr.read().image
                original = list(img.size)
                img.thumbnail((size, size))
                if normal:
                    img = unpack_normal(img)
                alpha = not opaque and img.mode in ("RGBA", "LA") and img.getchannel("A").getextrema()[0] < 250
                buf = io.BytesIO()
                if alpha:
                    img.convert("RGBA").save(buf, "PNG", optimize=True)
                    self.textures[key] = (buf.getvalue(), "image/png", True, original, img)
                else:
                    img.convert("RGB").save(buf, "JPEG", quality=88)
                    self.textures[key] = (buf.getvalue(), "image/jpeg", False, original, img)
            except Exception:
                self.failed += 1
        return self.textures[key]

    def material(self, ptr, size=MODEL_TEX, keep_props=False, opaque=False):
        """{name, color (sRGB rgba), texture, tiling, alpha} for one material. With
        keep_props, also every number and texture slot the material sets, so
        we can study how the game's shader uses them."""
        info = {"name": "", "color": [1, 1, 1, 1], "texture": None, "alpha": None}
        try:
            mat = ptr.read()
        except Exception:
            return info
        info["name"] = mat.m_Name
        props = mat.m_SavedProperties
        try:
            shader = mat.m_Shader.read().m_ParsedForm.m_Name
        except Exception:
            shader = ""
        info["alpha"] = None if opaque else alpha_mode(shader, mat)
        opaque = info["alpha"] is None
        colors = dict((k, v) for k, v in props.m_Colors)
        for key in ("_Color", "_BaseColor", "_MainColor", "_TintColor"):
            if key in colors:
                c = colors[key]
                info["color"] = [c.r, c.g, c.b, c.a]
                break
        texs = dict((k, v) for k, v in props.m_TexEnvs)
        for key in ("_MainTex", "_BaseMap", "_Albedo", "_MainTexture", "_Diffuse"):
            if key in texs and texs[key].m_Texture.path_id:
                info["texture"] = self.texture(texs[key].m_Texture, size, opaque)
                info["tiling"] = [texs[key].m_Scale.x, texs[key].m_Scale.y]
                if info["texture"]:
                    break
        for key in ("_BumpMap", "_NormalMap", "_Normal"):
            if key in texs and texs[key].m_Texture.path_id:
                info["normal"] = self.texture(texs[key].m_Texture, size, True, normal=True)
                break
        if keep_props:
            info["props"] = {
                "shader": shader,
                "floats": {k: round(v, 4) for k, v in props.m_Floats},
                "colors": {k: [round(c.r, 4), round(c.g, 4), round(c.b, 4), round(c.a, 4)] for k, c in props.m_Colors},
                "textures": {k: {"set": bool(v.m_Texture.path_id), "scale": [round(v.m_Scale.x, 4), round(v.m_Scale.y, 4)],
                                 "offset": [round(v.m_Offset.x, 4), round(v.m_Offset.y, 4)]} for k, v in props.m_TexEnvs},
            }
        return info


# ------------------------------------------------------------------ GLB writer
def srgb_to_linear(c):
    return [((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) for v in c[:3]] + [c[3]]


def write_glb(path, prims):
    """Minimal glTF 2.0 binary: one mesh, one primitive per material."""
    blob = bytearray()
    views, accessors, materials, textures, images, gl_prims = [], [], [], [], [], []

    def view(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        v = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target:
            v["target"] = target
        blob.extend(data)
        views.append(v)
        return len(views) - 1

    def accessor(arr, ctype, kind, target, minmax=False):
        a = {"bufferView": view(arr.tobytes(), target), "componentType": ctype, "count": len(arr), "type": kind}
        if minmax:
            a["min"] = arr.min(axis=0).tolist()
            a["max"] = arr.max(axis=0).tolist()
        accessors.append(a)
        return len(accessors) - 1

    for p in prims:
        attrs = {"POSITION": accessor(p["pos"], 5126, "VEC3", 34962, True)}
        if p["nrm"] is not None:
            attrs["NORMAL"] = accessor(p["nrm"], 5126, "VEC3", 34962)
        if p["uv"] is not None:
            attrs["TEXCOORD_0"] = accessor(p["uv"], 5126, "VEC2", 34962)
        idx = accessor(p["idx"], 5125, "SCALAR", 34963)
        m = p["material"]
        pbr = {"baseColorFactor": srgb_to_linear(m["color"]), "metallicFactor": 0.0, "roughnessFactor": 0.8}
        mat = {"name": m["name"], "pbrMetallicRoughness": pbr, "doubleSided": True}
        tex = m["texture"]
        if tex and p["uv"] is not None:
            images.append({"bufferView": view(tex[0]), "mimeType": tex[1]})
            textures.append({"source": len(images) - 1, "sampler": 0})
            pbr["baseColorTexture"] = {"index": len(textures) - 1}
            if tex[2] and m.get("alpha") == "mask":
                mat["alphaMode"] = "MASK"
                mat["alphaCutoff"] = 0.5
            elif tex[2] and m.get("alpha") == "blend":
                mat["alphaMode"] = "BLEND"
        if m["color"][3] < 0.98 and m.get("alpha") == "blend" and "alphaMode" not in mat:
            mat["alphaMode"] = "BLEND"
        materials.append(mat)
        gl_prims.append({"attributes": attrs, "indices": idx, "material": len(materials) - 1})

    while len(blob) % 4:
        blob.append(0)
    gltf = {
        "asset": {"version": "2.0", "generator": "3DX Editor extract_models.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": gl_prims}],
        "materials": materials, "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    if textures:
        gltf["textures"] = textures
        gltf["images"] = images
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(blob), 0x004E4942) + bytes(blob)
    path.write_bytes(out)


# ------------------------------------------------------------------ one prefab
def extract(go, lib, spare_mesh=None, level="near"):
    """All visible meshes of a prefab, merged per material, in three.js space
    (z flipped), relative to the prefab's root (the world file sets the root).

    level "near" is the full-detail model; "far" uses the prefab's simplest
    LOD level instead, for drawing it at a distance.

    Some prefabs have an empty mesh slot that the game fills while running;
    for those, `spare_mesh` (the mesh of the same name the game keeps in its
    resources) is used with the prefab's own material."""
    parts = components(go)
    root_t = parts["Transform"]
    every, near, far = lod_sets(root_t)
    wanted = near if level == "near" else far
    groups = {}  # material key -> lists
    lights = []  # the prefab's own lamps (Light components)
    stack = [(root_t, np.eye(4))]
    while stack:
        t, m = stack.pop()
        g = t.m_GameObject.read()
        if not getattr(g, "m_IsActive", True):
            continue
        p = components(g)
        rend = p.get("MeshRenderer") or p.get("SkinnedMeshRenderer")
        mesh_ptr = None
        if "SkinnedMeshRenderer" in p and not p.get("MeshRenderer"):
            mesh_ptr = p["SkinnedMeshRenderer"].m_Mesh
        elif "MeshFilter" in p:
            mesh_ptr = p["MeshFilter"].m_Mesh
        rid = rend.object_reader.path_id if rend is not None else None
        if rend is not None and mesh_ptr is not None and mesh_ptr.path_id \
                and (rid not in every or rid in wanted) and getattr(rend, "m_Enabled", True):
            add_mesh(groups, mesh_ptr.read(), m, rend, lib)
        light = p.get("Light")
        if light is not None and level == "near" and getattr(light, "m_Enabled", True):
            lights.append(light_info(light, m))
        for ch in children(t):
            stack.append((ch, m @ trs(ch)))
    if not groups and spare_mesh is not None and level == "near":
        rend = parts.get("MeshRenderer") or parts.get("SkinnedMeshRenderer")
        if rend is None:  # renderer on a child, empty slot on the root
            for ch in children(root_t):
                p = components(ch.m_GameObject.read())
                rend = p.get("MeshRenderer") or p.get("SkinnedMeshRenderer")
                if rend is not None:
                    break
        if rend is not None:
            add_mesh(groups, spare_mesh.read(), np.eye(4), rend, lib)
    prims = []
    for key, g in groups.items():
        if not g["idx"]:
            continue
        pos = np.concatenate(g["pos"]).astype(np.float32)
        nrm = np.concatenate(g["nrm"]).astype(np.float32) if all(x is not None for x in g["nrm"]) else None
        uv = np.concatenate(g["uv"]).astype(np.float32) if all(x is not None for x in g["uv"]) else None
        idx = np.concatenate(g["idx"]).astype(np.uint32)
        prims.append({"pos": pos, "nrm": nrm, "uv": uv, "idx": idx, "material": g["material"]})
    return prims, root_t, lights


def light_info(light, m):
    """A Light component as plain numbers, in the same three.js space as the
    model (z flipped), relative to the prefab's root."""
    c = light.m_Color
    pos = m[:3, 3].copy()
    pos[2] *= -1
    d = m[:3, :3] @ np.array([0.0, 0.0, 1.0])  # Unity lights shine along their local +z
    d /= max(np.linalg.norm(d), 1e-9)
    d[2] *= -1
    return {
        "type": LIGHT_TYPES.get(light.m_Type, str(light.m_Type)),
        "color": [round(c.r, 4), round(c.g, 4), round(c.b, 4)],
        "intensity": round(light.m_Intensity, 4),
        "range": round(light.m_Range, 4),
        "angle": round(getattr(light, "m_SpotAngle", 0.0), 2),
        "pos": [round(v, 4) for v in pos],
        "dir": [round(v, 4) for v in d],
        "shadows": int(getattr(getattr(light, "m_Shadows", None), "m_Type", 0) or 0),
    }


def add_mesh(groups, mesh, m, rend, lib):
    h = MeshHandler(mesh)
    h.process()
    count = h.m_VertexCount

    def cols(data, k):
        """Vertex data as count x k, whatever width it was stored with."""
        if data is None or not len(data) or not count:
            return None
        a = np.asarray(data, dtype=np.float64).reshape(count, -1)
        return a[:, :k] if a.shape[1] >= k else None

    v = cols(h.m_Vertices, 3)
    if v is None:
        return
    n = cols(h.m_Normals, 3)
    uv = cols(h.m_UV0, 2)
    vw = v @ m[:3, :3].T + m[:3, 3]
    if n is not None:
        nm = np.linalg.inv(m[:3, :3]).T
        n = n @ nm.T
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        n[:, 2] *= -1
    vw[:, 2] *= -1                       # Unity (left-handed) → three.js (right-handed)
    if uv is not None:
        uv = uv.copy()
        uv[:, 1] = 1 - uv[:, 1]          # glTF puts the texture origin top-left
    flip = np.linalg.det(m[:3, :3]) > 0  # the z flip mirrors once; a mirrored transform undoes it
    mats = list(rend.m_Materials)
    for si, tris in enumerate(h.get_triangles()):
        if not tris:
            continue
        mp = mats[min(si, len(mats) - 1)] if mats else None
        key = mp.path_id if mp is not None else 0
        if key not in groups:
            groups[key] = {"pos": [], "nrm": [], "uv": [], "idx": [], "count": 0,
                           "material": lib.material(mp) if mp is not None else {"name": "", "color": [1, 1, 1, 1], "texture": None}}
        g = groups[key]
        t = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
        if flip:
            t = t[:, [0, 2, 1]]
        used = np.unique(t)
        remap = np.full(len(vw), -1, dtype=np.int64)
        remap[used] = np.arange(len(used)) + g["count"]
        g["pos"].append(vw[used])
        g["nrm"].append(n[used] if n is not None else None)
        g["uv"].append(uv[used] if uv is not None else None)
        g["idx"].append(remap[t].reshape(-1))
        g["count"] += len(used)


# ------------------------------------------------------------------ skies (the weather)
# Unity cube faces in order: +x, -x, +y, -y, +z, -z (Unity's own axes).
FACE_DIRS = [  # for each face: (forward, right, up) in Unity space, to turn a pixel into a direction
    ((1, 0, 0), (0, 0, -1), (0, 1, 0)), ((-1, 0, 0), (0, 0, 1), (0, 1, 0)),
    ((0, 1, 0), (1, 0, 0), (0, 0, -1)), ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
    ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (-1, 0, 0), (0, 1, 0)),
]


def extract_skies(cont, resolve):
    """Every "sky/<name>" material: its six cube faces as pictures, plus the
    numbers the editor needs to light a room the way that weather does."""
    from UnityPy.export.Texture2DConverter import parse_image_data
    from PIL import Image
    out = CACHE / "skies"
    out.mkdir(parents=True, exist_ok=True)
    skies = {}
    for path, ptr in cont:
        if not path.startswith("sky/"):
            continue
        obj = resolve(ptr)
        if obj is None or obj.type.name != "Material":
            continue
        name = path.split("/", 1)[1]
        try:
            mat = obj.read()
            props = mat.m_SavedProperties
            texs = dict((k, v) for k, v in props.m_TexEnvs)
            floats = {k: v for k, v in props.m_Floats}
            colors = {k: [c.r, c.g, c.b] for k, c in props.m_Colors}
            entry = {
                "rotation": round(floats.get("_Rotation", 0.0), 2),
                "exposure": round(floats.get("_Exposure", 1.0), 3),
                "tint": [round(v, 3) for v in colors.get("_Tint", [1, 1, 1])],
                "sun_tint": [round(v, 3) for v in colors.get("_MoonTint", [0, 0, 0])],
            }
            if "_MoonTex" in texs and texs["_MoonTex"].m_Texture.path_id:
                entry["sun_texture"] = texs["_MoonTex"].m_Texture.read().m_Name   # "Sun" or "Moon"
            cube_ptr = texs.get("_Tex")
            if cube_ptr is None or not cube_ptr.m_Texture.path_id:
                entry["procedural"] = True  # the "realtime" sky draws itself; no picture
                skies[name] = entry
                continue
            cube = cube_ptr.m_Texture.read()
            data = cube.get_image_data()
            per_face = len(data) // 6
            folder = out / safe(name)
            folder.mkdir(exist_ok=True)
            # HDR skies (BC6H, half or float) decode to linear light values;
            # pictures for the screen need the usual sRGB curve on top
            hdr = int(cube.m_TextureFormat) in (17, 20, 22, 24)
            faces = []
            for i in range(6):
                img = parse_image_data(data[i * per_face:(i + 1) * per_face], cube.m_Width, cube.m_Height,
                                       cube.m_TextureFormat, cube.object_reader.version, cube.object_reader.platform,
                                       getattr(cube, "m_PlatformBlob", None), flip=False).convert("RGB")
                img.thumbnail((SKY_FACE, SKY_FACE))
                px = np.asarray(img, dtype=np.float32) / 255.0
                lin = px if hdr else np.where(px <= 0.04045, px / 12.92, ((px + 0.055) / 1.055) ** 2.4)
                srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
                Image.fromarray((np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(folder / f"{i}.jpg", "JPEG", quality=90)
                faces.append(lin)  # light is measured in linear values
            entry["hdr"] = hdr
            entry["faces"] = [f"skies/{safe(name)}/{i}.jpg" for i in range(6)]
            # light from the picture: average colour above and below the horizon,
            # and the direction of the brightest spot (the painted sun, if any)
            up_sum, up_n, down_sum, down_n = np.zeros(3), 0, np.zeros(3), 0
            best, best_dir = -1.0, None
            for (fwd, right, upv), px in zip(FACE_DIRS, faces):
                h, w, _ = px.shape
                v, u = np.mgrid[0:h, 0:w]
                a = (u + 0.5) / w * 2 - 1
                b = 1 - (v + 0.5) / h * 2
                dirs = np.array(fwd)[None, None, :] + a[..., None] * np.array(right) + b[..., None] * np.array(upv)
                dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)
                above = dirs[..., 1] > 0.05
                below = dirs[..., 1] < -0.05
                up_sum += px[above].sum(axis=0); up_n += above.sum()
                down_sum += px[below].sum(axis=0); down_n += below.sum()
                lum = px @ np.array([0.2126, 0.7152, 0.0722])
                lum = np.where(dirs[..., 1] > -0.1, lum, 0)  # a sun is never below the horizon
                k = np.unravel_index(np.argmax(lum), lum.shape)
                if lum[k] > best:
                    best, best_dir = float(lum[k]), dirs[k]
            entry["sky_color"] = [round(float(x), 4) for x in up_sum / max(up_n, 1)]
            entry["ground_color"] = [round(float(x), 4) for x in down_sum / max(down_n, 1)]
            entry["brightest"] = round(best, 3)
            entry["sun_dir"] = [round(float(x), 4) for x in best_dir]  # Unity axes, before the sky's rotation
            entry["size"] = cube.m_Width
            skies[name] = entry
        except Exception as err:
            skies[name] = {"error": f"{type(err).__name__}: {err}"}
    return skies


# ------------------------------------------------------------------ main
def main():
    sys.stdout.reconfigure(encoding="utf-8")
    given = Path(sys.argv[1].strip('" ')) if len(sys.argv) > 1 and sys.argv[1].strip('" ') else None
    data = (game_data(given) or given) if given else GAME_DEFAULT  # the game folder or its 3DXChat_Data
    if not data or not (data / "resources.assets").exists():
        raise SystemExit(f"Game data not found at {data}. Pass the 3DXChat game folder as an argument.")
    if given and game_data(given):
        save_choice("game", str(given))  # Settings → General shows it from now on
    t0 = time.time()
    env = UnityPy.load(*[str(data / f) for f in FILES if (data / f).exists()])
    files = {Path(k).name: f for k, f in env.files.items()}
    ggm = files["globalgamemanagers"]
    rm = next(o for o in ggm.objects.values() if o.type.name == "ResourceManager")
    cont = rm.read_typetree()["m_Container"]

    def resolve(ptr):
        fid, pid = ptr["m_FileID"], ptr["m_PathID"]
        f = ggm if fid == 0 else files.get(Path(ggm.externals[fid - 1].path).name)
        return f.objects.get(pid) if f else None

    # world object name → prefab. The "props prefabs" folder is what the world editor uses.
    prefabs = {}
    category = {}  # name → the game's own folder, e.g. "chairs" or "jungle/plants" (sorts the editor's dock)
    for path, ptr in cont:
        if path.startswith("props prefabs/") and "/meshes/" not in path:
            obj = resolve(ptr)
            if obj is not None and obj.type.name == "GameObject":
                name = path.rsplit("/", 1)[-1]
                if name not in prefabs:
                    prefabs[name] = obj
                    category[name] = path[len("props prefabs/"):].rsplit("/", 1)[0]
    for path, ptr in cont:  # fallback: same name elsewhere under props/
        if path.startswith("props/"):
            name = path.rsplit("/", 1)[-1]
            obj = resolve(ptr)
            if name not in prefabs and obj is not None and obj.type.name == "GameObject":
                prefabs[name] = obj
                rest = path[len("props/"):]
                category[name] = rest.rsplit("/", 1)[0] if "/" in rest else "other"
    # Spare meshes, for prefabs whose mesh slot is filled at run time. The game
    # keeps them in resources.assets as "<name>", "<name>_LOD0" or, for a few,
    # only "<name>_collision" (a simpler shape). Largest wins where names repeat.
    meshes = {}
    for obj in files["resources.assets"].objects.values():
        if obj.type.name != "Mesh":
            continue
        try:
            n = obj.peek_name().lower()
        except Exception:
            continue
        if n not in meshes or obj.byte_size > meshes[n].byte_size:
            meshes[n] = obj
    spares = {}
    for name in prefabs:
        for cand in (name + "_lod0", name, name + "_collision"):
            if cand in meshes:
                spares[name] = (0, meshes[cand])
                break
    print(f"game data loaded in {time.time() - t0:.0f} s; {len(prefabs)} objects to read, {len(spares)} spare meshes")

    out = CACHE / "models"
    out.mkdir(parents=True, exist_ok=True)
    lib = Library()
    index, failed = {}, []
    for i, (name, obj) in enumerate(sorted(prefabs.items())):
        try:
            go = obj.read()
            prims, root_t, lights = extract(go, lib, spares.get(name, (0, None))[1])
            if not prims:
                if lights:  # a pure lamp: no model, but its light still matters
                    s = root_t.m_LocalScale
                    index[name] = {"name": go.m_Name, "cat": category.get(name, "other"), "lights": lights,
                                   "scale": [round(s.x, 5), round(s.y, 5), round(s.z, 5)]}
                failed.append((name, "no mesh"))
                continue
            f = safe(name) + ".glb"
            write_glb(out / f, prims)
            s = root_t.m_LocalScale
            allpos = np.concatenate([p["pos"] for p in prims])
            # "name" is the prefab's own spelling, as world files write it (the index is lower case)
            tris = int(sum(len(p["idx"]) for p in prims) // 3)
            index[name] = {"file": f, "name": go.m_Name, "cat": category.get(name, "other"), "scale": [round(s.x, 5), round(s.y, 5), round(s.z, 5)],
                           "tris": tris,
                           "min": allpos.min(axis=0).round(4).tolist(), "max": allpos.max(axis=0).round(4).tolist()}
            if lights:
                index[name]["lights"] = lights
            # the game's own low-detail version, for drawing it far away (only if clearly lighter)
            far, _, _ = extract(go, lib, None, level="far")
            far_tris = int(sum(len(p["idx"]) for p in far) // 3)
            if far and far_tris <= tris * 0.6:
                write_glb(out / (safe(name) + ".far.glb"), far)
                index[name]["far"] = safe(name) + ".far.glb"
                index[name]["far_tris"] = far_tris
        except Exception as err:
            failed.append((name, f"{type(err).__name__}: {err}"))
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(prefabs)}")

    # world materials (the "m" field on shapes): home materials/<kind>/<name>/<name>
    mats_out = CACHE / "materials"
    if mats_out.exists():  # start clean so old files from earlier runs don't linger
        for f in mats_out.rglob("*"):
            if f.is_file():
                f.unlink()
    thumbs_out = mats_out / "thumbs"
    thumbs_out.mkdir(parents=True, exist_ok=True)
    mat_index = {}
    for path, ptr in cont:
        parts = path.split("/")
        if len(parts) == 4 and parts[0] == "home materials" and parts[2] == parts[3]:
            obj = resolve(ptr)
            if obj is None or obj.type.name != "Material" or parts[3] in mat_index:
                continue
            # the game's wall shaders keep shininess in the alpha channel, not see-through parts
            info = lib.material(type("P", (), {"read": lambda self, o=obj: o.read(), "path_id": obj.path_id})(),
                                WALL_TEX, keep_props=True, opaque=True)
            entry = {"color": [round(v, 4) for v in info["color"]], "kind": parts[1], "name": info["name"],
                     "props": info.get("props")}
            base = safe(parts[3])
            if info["texture"]:
                (mats_out / (base + ".jpg")).write_bytes(info["texture"][0])
                entry["file"] = base + ".jpg"
                entry["tiling"] = [round(v, 4) for v in info.get("tiling", [1, 1])]
                entry["source_px"] = info["texture"][3]
                # small picture for the library cards
                thumb = info["texture"][4].convert("RGB")
                thumb.thumbnail((128, 128))
                buf = io.BytesIO()
                thumb.save(buf, "JPEG", quality=82)
                (thumbs_out / (base + ".jpg")).write_bytes(buf.getvalue())
                entry["thumb"] = "thumbs/" + base + ".jpg"
            if info.get("normal"):
                (mats_out / (base + ".normal.jpg")).write_bytes(info["normal"][0])
                entry["normal"] = base + ".normal.jpg"
            mat_index[parts[3]] = entry

    skies = extract_skies(cont, resolve)

    (CACHE / "index.json").write_text(json.dumps({
        "game": str(data), "made": time.strftime("%Y-%m-%d %H:%M"),
        "models": index, "materials": mat_index, "skies": skies,
        "failed": dict(failed),
    }, indent=1), encoding="utf-8")
    size = sum(f.stat().st_size for f in CACHE.rglob("*") if f.is_file())
    print(f"done in {time.time() - t0:.0f} s: {len(index)} models, {len(mat_index)} materials, "
          f"{len(failed)} without a model, {lib.failed} textures unreadable, {size / 1e6:.0f} MB in {CACHE}")
    for name, why in failed[:25]:
        print(f"  no model: {name} ({why})")


if __name__ == "__main__":
    main()
