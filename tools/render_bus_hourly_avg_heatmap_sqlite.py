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

def color_for(v):
    if v is None: return (37, 43, 54)
    if v <= -3: return (22, 86, 54)
    if v < 0: return (34, 112, 68)
    if v < 1: return (70, 150, 95)
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

def fmt_avg(v):
    if v is None: return ''
    if abs(v) < 0.05: return '0'
    return f'{v:+.1f}'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=str(PROJECT / 'log' / 'bvg_delay_142_123_2026-05-08.sqlite'))
    ap.add_argument('--out', default=str(PROJECT / 'log' / 'bvg_bus_142_123_2026-05-08_hourly_avg_heatmap.png'))
    ap.add_argument('--lines', default='142,123')
    args = ap.parse_args()

    db = pathlib.Path(args.db)
    out = pathlib.Path(args.out)
    line_filter = [x.strip() for x in args.lines.split(',') if x.strip()]

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    placeholders = ','.join('?' for _ in line_filter)
    rows = con.execute(f'''
    SELECT l.line_name, s.target_min, s.observed_min, d.direction_name,
           o.trip_id, o.stop_sequence, st.stop_id, st.stop_name, o.delay_min
    FROM observations o
    JOIN snapshots s USING(snapshot_id)
    JOIN directions d USING(direction_id)
    JOIN lines l ON l.line_id = o.line_id
    JOIN stops st USING(stop_id)
    WHERE l.line_name IN ({placeholders}) AND o.delay_min IS NOT NULL
    ORDER BY l.line_name, d.direction_name, s.observed_min, o.stop_sequence
    ''', line_filter).fetchall()
    snap = con.execute('SELECT COUNT(*) c, MIN(target_min) mn, MAX(target_min) mx FROM snapshots').fetchone()
    con.close()

    by_panel = defaultdict(list)
    for r in rows:
        by_panel[(r['line_name'], r['direction_name'])].append(dict(r))

    panels = []
    global_hours = sorted({int(r['target_min']) // 60 for r in rows})
    for (line, direction), items in sorted(by_panel.items()):
        hours = sorted({int(r['target_min']) // 60 for r in items})
        stop_ids = sorted({r['stop_id'] for r in items}, key=lambda sid: statistics.median([x['stop_sequence'] for x in items if x['stop_id'] == sid]))
        stop_names = {sid: next(x['stop_name'] for x in items if x['stop_id'] == sid) for sid in stop_ids}
        vals = defaultdict(list)
        for r in items:
            vals[(int(r['target_min']) // 60, r['stop_id'])].append(r['delay_min'])
        avgmap = {k: sum(v) / len(v) for k, v in vals.items() if v}
        panels.append((line, direction, hours, stop_ids, stop_names, avgmap))

    font_title = load_font(28, True)
    font_sub = load_font(15)
    font_small = load_font(10)
    font_cell = load_font(11, True)
    font_axis = load_font(12)
    font_axis_bold = load_font(12, True)

    cell_w, cell_h = 34, 28
    left_w = 76
    header_h = 138
    panel_gap = 52
    right_pad = 30
    bottom_pad = 54
    legend_h = 42
    width = max(1120, max((left_w + len(p[3]) * cell_w + right_pad) for p in panels) if panels else 1120)
    height = 86 + legend_h + sum(header_h + len(p[2]) * cell_h + panel_gap for p in panels) + bottom_pad

    img = Image.new('RGB', (width, height), (18, 21, 27))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width, 74], fill=(240, 228, 0))
    draw.text((24, 14), 'BVG Bus Hourly Average Delay · Lines ' + ', '.join(line_filter), font=font_title, fill=(20, 20, 20))
    subtitle = f"Hourly mean delay by stop/direction. {snap['c']} snapshots, {len(rows)} observations, {snap['mn']//60:02d}:00–{snap['mx']//60:02d}:00. Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}."
    draw.text((24, 50), subtitle, font=font_sub, fill=(30, 30, 30))

    y = 88
    x = 24
    legend = [(-5, 'early'), (0, '0'), (3, '+3'), (7, '+7'), (12, '+12'), (20, '+20')]
    draw.text((x, y + 8), 'avg min', font=font_axis_bold, fill=(218, 224, 232)); x += 82
    for val, lab in legend:
        draw.rectangle([x, y + 8, x + 28, y + 28], fill=color_for(val), outline=(60, 65, 74))
        draw.text((x + 34, y + 7), lab, font=font_axis, fill=(218, 224, 232))
        x += 82

    y += legend_h
    for line, direction, hours, stop_ids, stop_names, avgmap in panels:
        draw.text((24, y), f'{line} → {direction}', font=font_sub, fill=(240, 228, 0))
        grid_x = left_w
        grid_y = y + header_h
        for i, sid in enumerate(stop_ids):
            tmp = Image.new('RGBA', (126, cell_w), (0, 0, 0, 0))
            td = ImageDraw.Draw(tmp)
            td.text((2, 8), short_stop(stop_names[sid]), font=font_small, fill=(198, 205, 215))
            rot = tmp.rotate(60, expand=True)
            img.paste(rot, (grid_x + i * cell_w - 16, y + 16), rot)
            draw.line([grid_x + i * cell_w, grid_y, grid_x + i * cell_w, grid_y + len(hours) * cell_h], fill=(42, 47, 56))
        draw.line([grid_x + len(stop_ids) * cell_w, grid_y, grid_x + len(stop_ids) * cell_w, grid_y + len(hours) * cell_h], fill=(42, 47, 56))

        for ri, hour in enumerate(hours):
            yy = grid_y + ri * cell_h
            draw.text((20, yy + 7), f'{hour:02d}:00', font=font_axis_bold, fill=(226, 230, 237))
            draw.line([grid_x, yy, grid_x + len(stop_ids) * cell_w, yy], fill=(42, 47, 56))
            for ci, sid in enumerate(stop_ids):
                val = avgmap.get((hour, sid))
                x0 = grid_x + ci * cell_w
                draw.rectangle([x0 + 1, yy + 1, x0 + cell_w - 1, yy + cell_h - 1], fill=color_for(val))
                txt = fmt_avg(val)
                if txt:
                    bbox = draw.textbbox((0, 0), txt, font=font_cell)
                    draw.text((x0 + (cell_w - (bbox[2] - bbox[0])) / 2, yy + 7), txt, font=font_cell, fill=(255, 255, 255))
        draw.line([grid_x, grid_y + len(hours) * cell_h, grid_x + len(stop_ids) * cell_w, grid_y + len(hours) * cell_h], fill=(42, 47, 56))
        y = grid_y + len(hours) * cell_h + panel_gap

    draw.text((24, height - 38), f'Source: {db.name}. Rows = hour, columns = stops, cell = average delay minutes from all sampled stop events in that hour.', font=font_axis, fill=(150, 158, 170))
    out.parent.mkdir(exist_ok=True)
    img.save(out)
    print(out)

if __name__ == '__main__':
    main()
