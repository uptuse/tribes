#!/usr/bin/env python3
"""Debug what scope each Turret object has."""
import sys
sys.path.insert(0, '/home/ubuntu/tribes/tools')
from parse_mis import parse_mis, OBJ_RE, PROP_RE, END_RE

text = open('/home/ubuntu/tribes/assets/tribes_original/base/missions/Raindance.MIS', encoding='latin-1').read()
objs = parse_mis(text)

print(f"total objects parsed: {len(objs)}\n")

# print all turrets
print("ALL TURRETS:")
for o in objs:
    if o['class'] == 'Turret':
        print(f"  {o['name']:25s} scope={o['scope']}")

print("\nALL TEAMGROUPS:")
for o in objs:
    if o['class'] == 'TeamGroup':
        print(f"  {o['name']:25s} scope={o['scope']}")

print("\nFIRST 10 SIMGROUPS:")
n = 0
for o in objs:
    if o['class'] == 'SimGroup':
        print(f"  {o['name']:25s} scope={o['scope']}")
        n += 1
        if n >= 10:
            break

# now manually track stack to see if team0 is ever in stack
print("\nMANUAL TRACE - showing stack state when first Turret encountered:")
stack = []
for lineno, line in enumerate(text.splitlines(), 1):
    m = OBJ_RE.match(line)
    if m:
        cls, name = m.group(1), m.group(2)
        stack.append((cls, name))
        if cls == 'Turret':
            print(f"  line {lineno}: pushed Turret '{name}', current stack:")
            for s in stack:
                print(f"    -> {s[0]}({s[1]})")
            break
        continue
    m = END_RE.match(line)
    if m:
        if stack:
            stack.pop()
