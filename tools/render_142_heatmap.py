#!/usr/bin/env python3
import json, math, pathlib, statistics
from collections import defaultdict
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

PROJECT = pathlib.Path(__file__).resolve().parents[1]
DATA = PROJECT / 'log' / 'bvg_142_delay_pilot.jsonl'
OUT = PROJECT / 'log' / 'bvg_142_delay_heatmap.png'

def load_font(size, bold=False):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    ]
    for p in candidates:
        try: return ImageFont.truetype(p, size)
        except Exception: pass
    return ImageFont.load_default()

font_title = load_font(28, True)
font_sub = load_font(15)
font_small = load_font(11)
font_cell = load_font(13, True)
font_axis = load_font(12)
font_axis_bold = load_font(12, True)

rows = []
for line in DATA.open(encoding='utf-8'):
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get('line_name') == '142' and r.get('delay_min') is not None:
        rows.append(r)

# Split by final direction and order stops by median sequence.
by_dir = defaultdict(list)
for r in rows:
    by_dir[r.get('direction') or 'unknown'].append(r)

def time_to_min(t):
    if not t or ':' not in t: return None
    h,m = map(int, t.split(':')[:2])
    return h*60+m

def color_for(v):
    # early/negative = deep green; punctual = green; late = amber/red/purple
    if v is None: return (37, 43, 54)
    if v <= -3: return (22, 86, 54)
    if v < 0: return (34, 112, 68)
    if v == 0: return (70, 150, 95)
    if v <= 3: return (184, 164, 74)
    if v <= 7: return (210, 126, 52)
    if v <= 12: return (202, 70, 60)
    return (142, 54, 120)

def text_color(v):
    if v is None: return (120, 128, 140)
    return (255,255,255)

def short_stop(name):
    if not name: return ''
    s = name.replace(' (Berlin)', '').replace('S+U ', '').replace('U ', '').replace('S ', '')
    s = s.replace('Berlin Hauptbahnhof', 'Hbf')
    s = s.replace('Lehrter Str./Invalidenstr.', 'Lehrter/Invaliden')
    s = s.replace('Invalidenpark', 'Invalidenpark')
    s = s.replace('Rosenthaler Platz', 'Rosenth. Platz')
    return s[:22]

def choose_cell(records, obs_time):
    # Multiple active trips may include the same stop. Show the row whose planned_time is closest to measurement time.
    om = time_to_min(obs_time)
    def key(r):
        pm = time_to_min(r.get('planned_time'))
        dist = abs((pm if pm is not None else 9999) - (om if om is not None else 0))
        # Prefer realtime/prognosed values if tie.
        prog_penalty = 0 if r.get('prognosis_type') else 5
        return (dist, prog_penalty)
    return sorted(records, key=key)[0]

panels = []
for direction, items in sorted(by_dir.items()):
    obs_times = sorted({r['observed_time'] for r in items})
    stop_ids = sorted({r['stop_id'] for r in items}, key=lambda sid: statistics.median([x['stop_sequence'] for x in items if x['stop_id']==sid]))
    stop_names = {sid: next((x['stop_name'] for x in items if x['stop_id']==sid), sid) for sid in stop_ids}
    cellmap = {}
    for ot in obs_times:
        for sid in stop_ids:
            rs = [x for x in items if x['observed_time']==ot and x['stop_id']==sid]
            if rs:
                pick = choose_cell(rs, ot)
                cellmap[(ot, sid)] = pick
    panels.append((direction, obs_times, stop_ids, stop_names, cellmap))

cell_w, cell_h = 34, 28
left_w = 72
header_h = 142
panel_gap = 58
right_pad = 30
bottom_pad = 46
legend_h = 42
width = max(980, max((left_w + len(p[2])*cell_w + right_pad) for p in panels) if panels else 980)
height = 86 + legend_h + sum(header_h + len(p[1])*cell_h + panel_gap for p in panels) + bottom_pad
img = Image.new('RGB', (width, height), (18, 21, 27))
d = ImageDraw.Draw(img)

# background stripes
d.rectangle([0,0,width,74], fill=(240,228,0))
d.text((24,18), 'BVG 142 Delay Pilot · Long-table heatmap', font=font_title, fill=(20,20,20))
d.text((24,52), f'Rows = measurement time, columns = stops. Cell = delay minutes; closest planned stop event selected. Generated {datetime.now().strftime("%H:%M")}.', font=font_sub, fill=(30,30,30))

# legend
y = 88
legend = [(-5,'early'),(0,'0'),(3,'+3'),(7,'+7'),(12,'+12'),(20,'+20')]
x = 24
d.text((x,y+8), 'delay min', font=font_axis_bold, fill=(218,224,232)); x += 82
for val, lab in legend:
    d.rectangle([x,y+8,x+28,y+28], fill=color_for(val), outline=(60,65,74))
    d.text((x+34,y+7), lab, font=font_axis, fill=(218,224,232))
    x += 82

y += legend_h
for direction, obs_times, stop_ids, stop_names, cellmap in panels:
    d.text((24,y), direction, font=font_sub, fill=(240,228,0))
    grid_x = left_w
    grid_y = y + header_h
    # station labels rotated
    for i,sid in enumerate(stop_ids):
        name = short_stop(stop_names[sid])
        # draw rotated label into temp image
        tw = 126; th = cell_w
        tmp = Image.new('RGBA', (tw, th), (0,0,0,0))
        td = ImageDraw.Draw(tmp)
        td.text((2, 8), name, font=font_small, fill=(198,205,215))
        rot = tmp.rotate(60, expand=True)
        img.paste(rot, (grid_x + i*cell_w - 18, y + 16), rot)
        # grid column line
        d.line([grid_x+i*cell_w, grid_y, grid_x+i*cell_w, grid_y+len(obs_times)*cell_h], fill=(42,47,56))
    d.line([grid_x+len(stop_ids)*cell_w, grid_y, grid_x+len(stop_ids)*cell_w, grid_y+len(obs_times)*cell_h], fill=(42,47,56))
    # rows
    for ri,ot in enumerate(obs_times):
        yy = grid_y + ri*cell_h
        d.text((20, yy+7), ot, font=font_axis_bold, fill=(226,230,237))
        d.line([grid_x, yy, grid_x+len(stop_ids)*cell_w, yy], fill=(42,47,56))
        for ci,sid in enumerate(stop_ids):
            rec = cellmap.get((ot,sid))
            val = rec.get('delay_min') if rec else None
            x0 = grid_x + ci*cell_w
            d.rectangle([x0+1, yy+1, x0+cell_w-1, yy+cell_h-1], fill=color_for(val))
            if val is not None:
                txt = f'{val:+d}' if val else '0'
                bbox = d.textbbox((0,0), txt, font=font_cell)
                d.text((x0+(cell_w-(bbox[2]-bbox[0]))/2, yy+6), txt, font=font_cell, fill=text_color(val))
    d.line([grid_x, grid_y+len(obs_times)*cell_h, grid_x+len(stop_ids)*cell_w, grid_y+len(obs_times)*cell_h], fill=(42,47,56))
    y = grid_y + len(obs_times)*cell_h + panel_gap

# footer
d.text((24,height-34), 'Note: snapshot data includes active trips returned by /trips; cells choose the stop event nearest to observed_time. Blank = no sampled active trip at that stop/time.', font=font_axis, fill=(150,158,170))
OUT.parent.mkdir(exist_ok=True)
img.save(OUT)
print(OUT)
