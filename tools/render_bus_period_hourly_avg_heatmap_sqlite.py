#!/usr/bin/env python3
import argparse, pathlib, sqlite3, statistics
from collections import defaultdict
from datetime import datetime, date
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
        'Stuttgarter Platz': 'Stuttg. Platz',
        'Lüneburger Str.': 'Lüneburger',
    }
    for a, b in replacements.items():
        s = s.replace(a, b)
    return s[:22]


def fmt_avg(v):
    if v is None: return ''
    if abs(v) < 0.05: return '0'
    return f'{v:+.1f}'


def service_date_from_db(path):
    # bvg_delay_142_123_YYYY-MM-DD.sqlite
    stem = path.stem
    return stem[-10:]


def wanted_period(service_date, period):
    wd = date.fromisoformat(service_date).weekday()  # Mon=0 ... Sun=6
    if period == 'weekday':
        return wd < 5
    if period == 'weekend':
        return wd >= 5
    return True


def fetch_rows(db_paths, line_filter, period):
    rows = []
    snap_count = 0
    days = []
    placeholders = ','.join('?' for _ in line_filter)
    for db in db_paths:
        svc = service_date_from_db(db)
        if not wanted_period(svc, period):
            continue
        con = sqlite3.connect(db)
        con.row_factory = sqlite3.Row
        n = con.execute('''
            SELECT COUNT(DISTINCT s.snapshot_id)
            FROM snapshots s
            WHERE EXISTS (
              SELECT 1 FROM observations o
              JOIN lines l ON l.line_id = o.line_id
              WHERE o.snapshot_id = s.snapshot_id
                AND l.line_name IN (%s)
                AND o.delay_min IS NOT NULL
            )
        ''' % placeholders, line_filter).fetchone()[0]
        db_rows = con.execute(f'''
            SELECT s.service_date, l.line_name, s.target_min, s.observed_min, d.direction_name,
                   o.trip_id, o.stop_sequence, st.stop_id, st.stop_name, o.delay_min
            FROM observations o
            JOIN snapshots s USING(snapshot_id)
            JOIN directions d USING(direction_id)
            JOIN lines l ON l.line_id = o.line_id
            JOIN stops st USING(stop_id)
            WHERE l.line_name IN ({placeholders}) AND o.delay_min IS NOT NULL
            ORDER BY l.line_name, d.direction_name, s.service_date, s.observed_min, o.stop_sequence
        ''', line_filter).fetchall()
        con.close()
        if db_rows:
            days.append(svc)
            snap_count += n
            rows.extend(dict(r) for r in db_rows)
    return rows, snap_count, days


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db-glob', default=str(PROJECT / 'log' / 'bvg_delay_142_123_2026-05-*.sqlite'))
    ap.add_argument('--out', required=True)
    ap.add_argument('--period', choices=['weekday', 'weekend', 'all'], required=True)
    ap.add_argument('--lines', default='142,123')
    args = ap.parse_args()

    db_paths = sorted(pathlib.Path().glob(args.db_glob) if not pathlib.Path(args.db_glob).is_absolute() else pathlib.Path('/').glob(args.db_glob[1:]))
    out = pathlib.Path(args.out)
    line_filter = [x.strip() for x in args.lines.split(',') if x.strip()]

    rows, snap_count, days = fetch_rows(db_paths, line_filter, args.period)
    if not rows:
        raise SystemExit(f'No effective rows for period={args.period}')

    by_panel = defaultdict(list)
    for r in rows:
        by_panel[(r['line_name'], r['direction_name'])].append(r)

    panels = []
    for (line, direction), items in sorted(by_panel.items()):
        hours = sorted({int(r['target_min']) // 60 for r in items})
        stop_ids = sorted({r['stop_id'] for r in items}, key=lambda sid: statistics.median([x['stop_sequence'] for x in items if x['stop_id'] == sid]))
        stop_names = {sid: next(x['stop_name'] for x in items if x['stop_id'] == sid) for sid in stop_ids}
        vals = defaultdict(list)
        for r in items:
            vals[(int(r['target_min']) // 60, r['stop_id'])].append(float(r['delay_min']))
        avgmap = {k: sum(v) / len(v) for k, v in vals.items() if v}
        panels.append((line, direction, hours, stop_ids, stop_names, avgmap, len(items)))

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
    bottom_pad = 58
    legend_h = 42
    width = max(1120, max((left_w + len(p[3]) * cell_w + right_pad) for p in panels))
    height = 86 + legend_h + sum(header_h + len(p[2]) * cell_h + panel_gap for p in panels) + bottom_pad

    img = Image.new('RGB', (width, height), (18, 21, 27))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width, 74], fill=(240, 228, 0))
    period_label = {'weekday': 'Weekday / 周中', 'weekend': 'Weekend / 周末', 'all': 'All days'}[args.period]
    draw.text((24, 14), f'BVG Bus Hourly Average Delay · {period_label}', font=font_title, fill=(20, 20, 20))
    subtitle = f"Lines {', '.join(line_filter)} · effective rows only (delay_min IS NOT NULL) · {snap_count} snapshots · {len(rows)} observations · days: {', '.join(days)} · Generated {datetime.now().strftime('%Y-%m-%d %H:%M')}"
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
    for line, direction, hours, stop_ids, stop_names, avgmap, item_count in panels:
        draw.text((24, y), f'{line} → {direction}  ({item_count:,} effective observations)', font=font_sub, fill=(240, 228, 0))
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

    draw.text((24, height - 40), 'Rows = hour, columns = stops, cell = average delay minutes. Invalid / missing realtime-delay observations are excluded.', font=font_axis, fill=(150, 158, 170))
    out.parent.mkdir(exist_ok=True)
    img.save(out)
    print(out)


if __name__ == '__main__':
    main()
