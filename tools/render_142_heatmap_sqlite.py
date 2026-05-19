#!/usr/bin/env python3
import pathlib, sqlite3, statistics
from collections import defaultdict
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

PROJECT = pathlib.Path(__file__).resolve().parents[1]
DB = PROJECT / 'log' / 'bvg_142_delay_pilot.sqlite'
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

def min_to_hm(m):
    m = int(m) % (24 * 60)
    return f'{m//60:02d}:{m%60:02d}'

def color_for(v):
    if v is None: return (37, 43, 54)
    if v <= -3: return (22, 86, 54)
    if v < 0: return (34, 112, 68)
    if v == 0: return (70, 150, 95)
    if v <= 3: return (184, 164, 74)
    if v <= 7: return (210, 126, 52)
    if v <= 12: return (202, 70, 60)
    return (142, 54, 120)

def status_for(planned_min, delay_min, observed_min):
    if delay_min is None:
        estimate = planned_min
    else:
        estimate = planned_min + delay_min
    return 'passed' if estimate <= observed_min else 'upcoming'

def short_stop(name):
    s = (name or '').replace(' (Berlin)', '').replace('S+U ', '').replace('U ', '').replace('S ', '')
    s = s.replace('Berlin Hauptbahnhof', 'Hbf')
    s = s.replace('Lehrter Str./Invalidenstr.', 'Lehrter/Invaliden')
    s = s.replace('Rosenthaler Platz', 'Rosenth. Platz')
    return s[:22]

font_title = load_font(28, True)
font_sub = load_font(15)
font_small = load_font(11)
font_cell = load_font(13, True)
font_axis = load_font(12)
font_axis_bold = load_font(12, True)

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
rows = con.execute('''
SELECT s.snapshot_key, s.service_date, s.target_min, s.observed_min,
       d.direction_name, o.trip_id, o.stop_sequence, st.stop_id, st.stop_name,
       o.planned_min, o.delay_min, o.prognosis_code
FROM observations o
JOIN snapshots s USING(snapshot_id)
JOIN directions d USING(direction_id)
JOIN stops st USING(stop_id)
WHERE d.line_name = '142'
ORDER BY s.observed_min, d.direction_name, o.trip_id, o.stop_sequence
''').fetchall()
con.close()

by_dir = defaultdict(list)
for r in rows:
    by_dir[r['direction_name']].append(dict(r))

def choose_cell(records, observed_min):
    # Same display rule: if several active trips cover this station, show trip whose planned stop time is closest to measurement.
    return sorted(records, key=lambda r: (abs(r['planned_min'] - observed_min), 0 if r['prognosis_code'] else 5))[0]

panels = []
for direction, items in sorted(by_dir.items()):
    obs_mins = sorted({r['observed_min'] for r in items})
    stop_ids = sorted({r['stop_id'] for r in items}, key=lambda sid: statistics.median([x['stop_sequence'] for x in items if x['stop_id'] == sid]))
    stop_names = {sid: next(x['stop_name'] for x in items if x['stop_id'] == sid) for sid in stop_ids}
    cellmap = {}
    for om in obs_mins:
        for sid in stop_ids:
            rs = [x for x in items if x['observed_min'] == om and x['stop_id'] == sid]
            if rs:
                cellmap[(om, sid)] = choose_cell(rs, om)
    panels.append((direction, obs_mins, stop_ids, stop_names, cellmap))

cell_w, cell_h = 34, 28
left_w = 72
header_h = 142
panel_gap = 58
right_pad = 30
bottom_pad = 46
legend_h = 42
width = max(980, max((left_w + len(p[2]) * cell_w + right_pad) for p in panels) if panels else 980)
height = 86 + legend_h + sum(header_h + len(p[1]) * cell_h + panel_gap for p in panels) + bottom_pad
img = Image.new('RGB', (width, height), (18, 21, 27))
draw = ImageDraw.Draw(img)

draw.rectangle([0, 0, width, 74], fill=(240, 228, 0))
draw.text((24, 18), 'BVG 142 Delay Pilot · SQLite heatmap', font=font_title, fill=(20, 20, 20))
draw.text((24, 52), f'Rows = measurement time, columns = stops. Cell = delay minutes. Generated {datetime.now().strftime("%H:%M")}.', font=font_sub, fill=(30, 30, 30))

y = 88
legend = [(-5, 'early'), (0, '0'), (3, '+3'), (7, '+7'), (12, '+12'), (20, '+20')]
x = 24
draw.text((x, y + 8), 'delay min', font=font_axis_bold, fill=(218, 224, 232)); x += 82
for val, lab in legend:
    draw.rectangle([x, y + 8, x + 28, y + 28], fill=color_for(val), outline=(60, 65, 74))
    draw.text((x + 34, y + 7), lab, font=font_axis, fill=(218, 224, 232))
    x += 82

y += legend_h
for direction, obs_mins, stop_ids, stop_names, cellmap in panels:
    draw.text((24, y), direction, font=font_sub, fill=(240, 228, 0))
    grid_x = left_w
    grid_y = y + header_h
    for i, sid in enumerate(stop_ids):
        tmp = Image.new('RGBA', (126, cell_w), (0, 0, 0, 0))
        td = ImageDraw.Draw(tmp)
        td.text((2, 8), short_stop(stop_names[sid]), font=font_small, fill=(198, 205, 215))
        rot = tmp.rotate(60, expand=True)
        img.paste(rot, (grid_x + i * cell_w - 18, y + 16), rot)
        draw.line([grid_x + i * cell_w, grid_y, grid_x + i * cell_w, grid_y + len(obs_mins) * cell_h], fill=(42, 47, 56))
    draw.line([grid_x + len(stop_ids) * cell_w, grid_y, grid_x + len(stop_ids) * cell_w, grid_y + len(obs_mins) * cell_h], fill=(42, 47, 56))

    for ri, om in enumerate(obs_mins):
        yy = grid_y + ri * cell_h
        draw.text((20, yy + 7), min_to_hm(om), font=font_axis_bold, fill=(226, 230, 237))
        draw.line([grid_x, yy, grid_x + len(stop_ids) * cell_w, yy], fill=(42, 47, 56))
        for ci, sid in enumerate(stop_ids):
            rec = cellmap.get((om, sid))
            val = rec['delay_min'] if rec else None
            x0 = grid_x + ci * cell_w
            draw.rectangle([x0 + 1, yy + 1, x0 + cell_w - 1, yy + cell_h - 1], fill=color_for(val))
            if val is not None:
                txt = f'{val:+d}' if val else '0'
                bbox = draw.textbbox((0, 0), txt, font=font_cell)
                draw.text((x0 + (cell_w - (bbox[2] - bbox[0])) / 2, yy + 6), txt, font=font_cell, fill=(255, 255, 255))
    draw.line([grid_x, grid_y + len(obs_mins) * cell_h, grid_x + len(stop_ids) * cell_w, grid_y + len(obs_mins) * cell_h], fill=(42, 47, 56))
    y = grid_y + len(obs_mins) * cell_h + panel_gap

draw.text((24, height - 34), 'SQLite normalized source: snapshots + stops + directions + observations. Status is derived, not stored.', font=font_axis, fill=(150, 158, 170))
OUT.parent.mkdir(exist_ok=True)
img.save(OUT)
print(OUT)
