#!/usr/bin/env python3
"""
Parse a Tribes 1 .MIS (TorqueScript mission) into a clean JSON describing
every gameplay object: flags, drop points, turrets, sensors, items, static
shapes (generators, inv stations, vehicle pads, command stations), interior
shapes (bases, bridges), and global mission settings (terrain origin, sky,
sun, rain, gravity, fog).

Usage: python3 parse_mis.py <input.MIS> <output.json>

The .MIS format is a nested block of `instant <Class> "<Name>" { key = "val"; }`
blocks. We don't need a full TorqueScript parser — a regex over the flat token
stream is sufficient because every property is on its own line and quoted.
"""
import json
import re
import sys
from pathlib import Path

OBJ_RE = re.compile(r'^\s*instant\s+(\w+)(?:\s+"([^"]+)")?\s*\{')
PROP_RE = re.compile(r'^\s*(\w+(?:\[\d+\])?)\s*=\s*"([^"]*)"\s*;')
END_RE = re.compile(r'^\s*\};')

WANTED_GROUPS = {"team0", "team1"}  # for tagging team membership


def parse_vec(s):
    """Parse 'x y z' into [x, y, z] floats; return None if malformed."""
    parts = s.strip().split()
    try:
        return [float(p) for p in parts] if len(parts) >= 2 else None
    except ValueError:
        return None


def parse_mis(text):
    """Stack-based parser. Each entry on stack is a dict with class/name/props.
    On `};` we pop and emit. Scope of an emitted object is the names of all
    its ancestors (excluding itself)."""
    objs = []
    stack = []  # list of dicts: {class, name, props}
    for line in text.splitlines():
        m = OBJ_RE.match(line)
        if m:
            stack.append({"class": m.group(1), "name": m.group(2) or "", "props": {}})
            continue
        m = PROP_RE.match(line)
        if m and stack:
            stack[-1]["props"][m.group(1)] = m.group(2)
            continue
        m = END_RE.match(line)
        if m and stack:
            top = stack.pop()
            objs.append({
                "class": top["class"],
                "name": top["name"],
                "props": top["props"],
                "scope": [s["name"] for s in stack],
            })
    return objs


def team_of(scope):
    for s in scope:
        if s in WANTED_GROUPS:
            return 0 if s == "team0" else 1
    return -1


def cleanup(objs):
    """Convert raw objs into a structured canonical JSON."""
    out = {
        "map": "Raindance",
        "source": "base/missions/Raindance.MIS (Sierra/Dynamix 1998)",
        "global": {},
        "terrain": {},
        "sky": {},
        "sun": {},
        "weather": {},
        "team0": {"start": [], "drop_points": [], "flag": None, "turrets": [], "sensors": [], "static_shapes": [], "items": []},
        "team1": {"start": [], "drop_points": [], "flag": None, "turrets": [], "sensors": [], "static_shapes": [], "items": []},
        "neutral_static_shapes": [],
        "neutral_interior_shapes": [],
        "neutral_markers": [],
    }
    for o in objs:
        cls = o["class"]
        props = o["props"]
        name = o["name"]
        scope = o["scope"]
        team = team_of(scope)
        team_key = f"team{team}" if team in (0, 1) else None

        pos = parse_vec(props.get("position", ""))
        rot = parse_vec(props.get("rotation", ""))
        datablock = props.get("dataBlock", "")
        filename = props.get("fileName", "")

        if cls == "MissionCenterPos":
            out["global"]["mission_center"] = {
                "x": float(props.get("x", 0)),
                "y": float(props.get("y", 0)),
                "w": float(props.get("w", 0)),
                "h": float(props.get("h", 0)),
            }
        elif cls == "SimTerrain":
            out["terrain"] = {
                "ted_file": props.get("tedFileName", ""),
                "position": parse_vec(props.get("position", "")),
                "visible_distance_m": float(props.get("visibleDistance", 0)),
                "haze_distance_m": float(props.get("hazeDistance", 0)),
                "perspective_distance_m": float(props.get("perspectiveDistance", 0)),
                "screen_size": float(props.get("screenSize", 0)),
                "gravity": parse_vec(props.get("contGravity", "")),
            }
        elif cls == "Sky":
            out["sky"] = {k: props.get(k, "") for k in ("dmlName", "skyColor", "hazeColor", "size", "distance")}
        elif cls == "Planet":
            out["sun"] = {
                "azimuth_deg": float(props.get("azimuth", 0)),
                "incidence_deg": float(props.get("incidence", 0)),
                "intensity_rgb": parse_vec(props.get("intensity", "")),
                "ambient_rgb": parse_vec(props.get("ambient", "")),
                "size": float(props.get("size", 0)),
                "distance": float(props.get("distance", 0)),
                "cast_shadows": props.get("castShadows", "False") == "True",
            }
        elif cls == "Snowfall":
            out["weather"] = {
                "type": "rain" if props.get("rain", "False") == "True" else "snow",
                "intensity": float(props.get("intensity", 0)),
                "wind": parse_vec(props.get("wind", "")),
            }
        elif cls == "Marker":
            entry = {"name": name, "datablock": datablock, "position": pos}
            if team_key:
                if "Start" in scope:
                    out[team_key]["start"].append(entry)
                else:
                    out[team_key]["drop_points"].append(entry)
            else:
                out["neutral_markers"].append(entry)
        elif cls == "Item":
            entry = {"name": name, "datablock": datablock, "position": pos, "rotation": rot}
            if datablock == "Flag" and team_key:
                out[team_key]["flag"] = entry
            elif team_key:
                out[team_key]["items"].append(entry)
            else:
                out["neutral_static_shapes"].append({"_item": True, **entry})
        elif cls == "Turret":
            entry = {"name": name, "datablock": datablock, "position": pos, "rotation": rot}
            if team_key:
                out[team_key]["turrets"].append(entry)
            else:
                out["neutral_static_shapes"].append({"_turret": True, **entry})
        elif cls == "Sensor":
            entry = {"name": name, "datablock": datablock, "position": pos, "rotation": rot}
            if team_key:
                out[team_key]["sensors"].append(entry)
            else:
                out["neutral_static_shapes"].append({"_sensor": True, **entry})
        elif cls == "StaticShape":
            entry = {"name": name, "datablock": datablock, "position": pos, "rotation": rot}
            if team_key:
                out[team_key]["static_shapes"].append(entry)
            else:
                out["neutral_static_shapes"].append(entry)
        elif cls == "InteriorShape":
            entry = {
                "name": name,
                "fileName": filename,
                "position": pos,
                "rotation": rot,
                "isContainer": props.get("isContainer", "0") == "1",
            }
            out["neutral_interior_shapes"].append(entry)
    return out


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: parse_mis.py <input.MIS> <output.json>", file=sys.stderr)
        sys.exit(1)
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    text = src.read_text(encoding="latin-1")  # MIS files are 8-bit ASCII
    objs = parse_mis(text)
    canonical = cleanup(objs)
    dst.write_text(json.dumps(canonical, indent=2))
    print(f"parsed {len(objs)} blocks from {src.name}")
    print(f"team0: flag={'OK' if canonical['team0']['flag'] else 'MISSING'}, "
          f"turrets={len(canonical['team0']['turrets'])}, "
          f"static_shapes={len(canonical['team0']['static_shapes'])}, "
          f"drop_points={len(canonical['team0']['drop_points'])}")
    print(f"team1: flag={'OK' if canonical['team1']['flag'] else 'MISSING'}, "
          f"turrets={len(canonical['team1']['turrets'])}, "
          f"static_shapes={len(canonical['team1']['static_shapes'])}, "
          f"drop_points={len(canonical['team1']['drop_points'])}")
    print(f"neutral interior shapes: {len(canonical['neutral_interior_shapes'])}")
    print(f"neutral static shapes:   {len(canonical['neutral_static_shapes'])}")
    print(f"weather: {canonical['weather']}")
    print(f"sun:     {canonical['sun']}")
    print(f"terrain: {canonical['terrain']}")
    print(f"wrote {dst} ({dst.stat().st_size} bytes)")
