#!/usr/bin/env python3
import argparse, pathlib, sqlite3, statistics
from collections import defaultdict
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

PROJECT = pathlib.Path(__file__).resolve().parents[1]

def load_font(size, bold=False):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
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

def short_stop(name):
    s = (name or '').replace(' (Berlin)', '').replace('S+U ', '').replace('U ', '').replace('S ', '')
    replacements = {
        'Berlin Hauptbahnhof': 'Hbf',
        'Hauptbahnhof': 'Hbf',
        'Lehrter Str./Invalidenstr.': 'Lehrter/Invaliden',
        'Rosenthaler Platz': 'Rosenth. Platz',
        'Rosa-Luxemburg-Platz': 'Rosa-Lux.',
        'Saatwinkler Damm/Mäckeritzwiesen': 'Saatwinkler/Mäck.',
        'Charlottenburg-Nord': 'Charl.-Nord',
    }
    for a, b in replacements.items():
        s = s.replace(a, b)
    return s[:22]

def choose_cell(records, observed_min):
    return sorted(records, key=lambda r: (abs(r['planned_min'] - observed_min), 0 if r['prognosis_code'] else 5))[0]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=str(PROJECT / 'log' / 'bvg_delay_142_123_2026-05-08.sqlite'))
    ap.add_argument('--out', default=str(PROJECT / 'log' / 'bvg_bus_142_123_heatmap.png'))
    ap.add_argument('--lines', default='142,123')
    args = ap.parse_args()

    db = pathlib.Path(args.db)
    out = pathlib.Path(args.out)
    line_filter = [x.strip() for x in args.lines.split(',') if x.strip()]

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    placeholders = ','.join('?' for _ in line_filter)
    rows = con.execute(f'''
    SELECT l.line_name, s.snapshot_key, s.service_date, s.target_min, s.observed_min,
           d.direction_name, o.trip_id, o.stop_sequence, st.stop_id, st.stop_name,
           o.planned_min, o.delay_min, o.prognosis_code
    FROM observations o
    JOIN snapshots s USING(snapshot_id)
    JOIN directions d USING(direction_id)
    JOIN lines l ON l.line_id = o.line_id
    JOIN stops st USING(stop_id)
    WHERE l.line_name IN ({placeholders})
    ORDER BY l.line_name, s.observed_min, d.direction_name, o.trip_id, o.stop_sequence
    ''', line_filter).fetchall()
    snap = con.execute('SELECT COUNT(*) c, MIN(observed_min) mn, MAX(observed_min) mx FROM snapshots').fetchone()
    con.close()

    by_panel = defaultdict(list)
    for r in rows:
        by_panel[(r['line_name'], r['direction_name'])].append(dict(r))

    panels = []
    for (line, direction), items in sorted(by_panel.items()):
        obs_mins = sorted({r['observed_min'] for r in items})
        stop_ids = sorted({r['stop_id'] for r in items}, key=lambda sid: statistics.median([x['stop_sequence'] for x in items if x['stop_id'] == sid]))
        stop_names = {sid: next(x['stop_name'] for x in items if x['stop_id'] == sid) for sid in stop_ids}
        cellmap = {}
        for om in obs_mins:
            for sid in stop_ids:
                rs = [x for x in items if x['observed_min'] == om and x['stop_id'] == sid]
                if rs:
                    cellmap[(om, sid)] = choose_cell(rs, om)
        panels.append((line, direction, obs_mins, stop_ids, stop_names, cellmap))

    font_title = load_font(28, True)
    font_sub = load_font(15)
    font_small = load_font(10)
    font_cell = load_font(12, True)
    font_axis = load_font(12)
    font_axis_bold = load_font(12, True)

    cell_w, cell_h = 30, 25
    left_w = 72
    header_h = 138
    panel_gap = 52
    right_pad = 30
    bottom_pad = 46
    legend_h = 42
    width = max(1120, max((left_w + len(p[3]) * cell_w + right_pad) for p in panels) if panels else 1120)
    height = 86 + legend_h + sum(header_h + len(p[2]) * cell_h + panel_gap for p in panels) + bottom_pad

    img = Image.new('RGB', (width, height), (18, 21, 27))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width, 74], fill=(240, 228, 0))
    title = 'BVG Bus Delay Heatmap · Lines ' + ', '.join(line_filter)
    draw.text((24, 14), title, font=font_title, fill=(20, 20, 20))
    subtitle = f"{snap['c']} snapshots, {len(rows)} observations, {min_to_hm(snap['mn'])}–{min_to_hm(snap['mx'])}. Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}."
    draw.text((24, 50), subtitle, font=font_sub, fill=(30, 30, 30))

    y = 88
    x = 24
    legend = [(-5, 'early'), (0, '0'), (3, '+3'), (7, '+7'), (12, '+12'), (20, '+20')]
    draw.text((x, y + 8), 'delay min', font=font_axis_bold, fill=(218, 224, 232)); x += 82
    for val, lab in legend:
        draw.rectangle([x, y + 8, x + 28, y + 28], fill=color_for(val), outline=(60, 65, 74))
        draw.text((x + 34, y + 7), lab, font=font_axis, fill=(218, 224, 232))
        x += 82

    y += legend_h
    for line, direction, obs_mins, stop_ids, stop_names, cellmap in panels:
        draw.text((24, y), f'{line} → {direction}', font=font_sub, fill=(240, 228, 0))
        grid_x = left_w
        grid_y = y + header_h
        for i, sid in enumerate(stop_ids):
            tmp = Image.new('RGBA', (126, cell_w), (0, 0, 0, 0))
            td = ImageDraw.Draw(tmp)
            td.text((2, 8), short_stop(stop_names[sid]), font=font_small, fill=(198, 205, 215))
            rot = tmp.rotate(60, expand=True)
            img.paste(rot, (grid_x + i * cell_w - 16, y + 16), rot)
            draw.line([grid_x + i * cell_w, grid_y, grid_x + i * cell_w, grid_y + len(obs_mins) * cell_h], fill=(42, 47, 56))
        draw.line([grid_x + len(stop_ids) * cell_w, grid_y, grid_x + len(stop_ids) * cell_w, grid_y + len(obs_mins) * cell_h], fill=(42, 47, 56))

        for ri, om in enumerate(obs_mins):
            yy = grid_y + ri * cell_h
            draw.text((20, yy + 6), min_to_hm(om), font=font_axis_bold, fill=(226, 230, 237))
            draw.line([grid_x, yy, grid_x + len(stop_ids) * cell_w, yy], fill=(42, 47, 56))
            for ci, sid in enumerate(stop_ids):
                rec = cellmap.get((om, sid))
                val = rec['delay_min'] if rec else None
                x0 = grid_x + ci * cell_w
                draw.rectangle([x0 + 1, yy + 1, x0 + cell_w - 1, yy + cell_h - 1], fill=color_for(val))
                if val is not None:
                    txt = f'{val:+d}' if val else '0'
                    bbox = draw.textbbox((0, 0), txt, font=font_cell)
                    draw.text((x0 + (cell_w - (bbox[2] - bbox[0])) / 2, yy + 5), txt, font=font_cell, fill=(255, 255, 255))
        draw.line([grid_x, grid_y + len(obs_mins) * cell_h, grid_x + len(stop_ids) * cell_w, grid_y + len(obs_mins) * cell_h], fill=(42, 47, 56))
        y = grid_y + len(obs_mins) * cell_h + panel_gap

    draw.text((24, height - 34), f'Source: {db.name}. Rows = measurement time, columns = stops, cell = selected closest planned stop delay.', font=font_axis, fill=(150, 158, 170))
    out.parent.mkdir(exist_ok=True)
    img.save(out)
    print(out)

if __name__ == '__main__':
    main()
