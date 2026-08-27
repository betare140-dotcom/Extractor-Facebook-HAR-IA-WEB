import base64
import csv
import html
import json
import os
import re
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs
from xml.sax.saxutils import escape

MEXICO_TZ = timezone(timedelta(hours=-6))


def _clean_xml_text(value):
    if value is None:
        return ""
    s = str(value)
    s = ''.join(ch for ch in s if ch in '\t\n\r' or ord(ch) >= 32)
    return s[:32760]


def _get_path(obj, path):
    cur = obj
    for key in path:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return None
    return cur


def _iter_dicts(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _iter_dicts(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_dicts(v)


def _friendly_name(entry):
    post = entry.get('request', {}).get('postData', {}).get('text', '') or ''
    try:
        q = parse_qs(post, keep_blank_values=True)
        return (q.get('fb_api_req_friendly_name') or [''])[0]
    except Exception:
        m = re.search(r'(?:^|&)fb_api_req_friendly_name=([^&]+)', post)
        return m.group(1) if m else ''


def _decode_response_text(entry):
    content = entry.get('response', {}).get('content', {}) or {}
    text = content.get('text') or ''
    if content.get('encoding') == 'base64' and text:
        try:
            return base64.b64decode(text).decode('utf-8', errors='replace')
        except Exception:
            return ''
    return text


def _json_chunks(text):
    # Facebook HAR responses commonly contain JSONL / streamed GraphQL chunks.
    if not text:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith('for (;;);'):
            line = line[len('for (;;);'):].lstrip()
        try:
            yield json.loads(line)
        except Exception:
            # Some HAR exporters preserve one regular JSON object without line breaks.
            pass
    # Fallback for a normal single JSON response.
    stripped = text.strip()
    if stripped and '\n' not in stripped:
        if stripped.startswith('for (;;);'):
            stripped = stripped[len('for (;;);'):].lstrip()
        try:
            yield json.loads(stripped)
        except Exception:
            return


def _iter_story_nodes(obj):
    for d in _iter_dicts(obj):
        if (
            d.get('__typename') == 'Story'
            and d.get('post_id')
            and d.get('creation_time')
            and d.get('permalink_url')
            and isinstance(d.get('actors'), list)
        ):
            yield d


def _extract_message(story):
    candidates = [
        _get_path(story, ('comet_sections', 'content', 'story', 'message', 'text')),
        _get_path(story, ('comet_sections', 'content', 'story', 'comet_sections', 'message', 'story', 'message', 'text')),
        _get_path(story, ('comet_sections', 'content', 'story', 'comet_sections', 'message_container', 'story', 'message', 'text')),
    ]
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()

    # Conservative fallback: only inspect the content branch, not feedback/comments.
    content = _get_path(story, ('comet_sections', 'content')) or {}
    texts = []
    for d in _iter_dicts(content):
        msg = d.get('message')
        if isinstance(msg, dict):
            txt = msg.get('text')
            if isinstance(txt, str) and txt.strip():
                texts.append(txt.strip())
        txt = d.get('text')
        if isinstance(txt, str) and len(txt.strip()) >= 8:
            texts.append(txt.strip())
    if texts:
        return max(texts, key=len)
    return ''


def _extract_mentions(story, message):
    vals = []
    # Textual hashtags / @mentions.
    vals.extend(re.findall(r'(?<!\w)[#@][\wÁÉÍÓÚÜÑáéíóúüñ]+', message or '', flags=re.UNICODE))

    # Entities embedded by Facebook in the post message.
    content = _get_path(story, ('comet_sections', 'content')) or {}
    for d in _iter_dicts(content):
        ranges = d.get('ranges')
        if not isinstance(ranges, list):
            continue
        for r in ranges:
            if not isinstance(r, dict):
                continue
            ent = r.get('entity')
            if not isinstance(ent, dict):
                continue
            typ = ent.get('__typename') or ''
            if typ in {'User', 'Page', 'Profile'}:
                name = ent.get('name') or ent.get('short_name')
                if name:
                    vals.append(str(name).strip())
            elif typ == 'Hashtag':
                url = ent.get('url') or ''
                m = re.search(r'/hashtag/([^?/#]+)', url)
                if m:
                    try:
                        from urllib.parse import unquote
                        vals.append('#' + unquote(m.group(1)))
                    except Exception:
                        pass
    seen = set()
    out = []
    for v in vals:
        k = v.casefold()
        if v and k not in seen:
            seen.add(k)
            out.append(v)
    return ', '.join(out)


def _collect_typenames(obj):
    result = []
    for d in _iter_dicts(obj):
        t = d.get('__typename')
        if t:
            result.append(str(t))
    return result


def _detect_format(story):
    url = (story.get('permalink_url') or '').lower()
    attachments = story.get('attachments') or []
    types = _collect_typenames(attachments)
    c = Counter(types)
    if '/reel/' in url or any('Shorts' in t or 'Reel' in t for t in types):
        return 'Reel'
    if c.get('Video', 0) or any('Video' in t for t in types):
        return 'Video'
    photo_count = c.get('Photo', 0)
    if photo_count > 2 or any('Album' in t for t in types):
        return 'Álbum / fotografías'
    if photo_count:
        return 'Fotografía'
    if attachments:
        return 'Enlace / adjunto'
    return 'Texto'


def _metric_from_action_renderers(story, kind):
    renderers = _get_path(story, (
        'comet_sections', 'feedback', 'story', 'story_ufi_container', 'story',
        'feedback_context', 'feedback_target_with_context',
        'comet_ufi_summary_and_actions_renderer', 'feedback', 'adaptive_ufi_action_renderers'
    ))
    if not isinstance(renderers, list):
        return None
    for item in renderers:
        fb = item.get('feedback') if isinstance(item, dict) else None
        if not isinstance(fb, dict):
            continue
        if kind == 'reactions':
            v = _get_path(fb, ('reaction_count', 'count'))
            if isinstance(v, (int, float)):
                return int(v)
        elif kind == 'comments':
            v = _get_path(fb, ('comment_rendering_instance', 'comments', 'total_count'))
            if isinstance(v, (int, float)):
                return int(v)
        elif kind == 'shares':
            v = _get_path(fb, ('share_count', 'count'))
            if isinstance(v, (int, float)):
                return int(v)
            v = fb.get('i18n_share_count')
            if isinstance(v, (int, float)):
                return int(v)
    return None


def _metric_fallback(story, kind):
    values = []
    for d in _iter_dicts(_get_path(story, ('comet_sections', 'feedback')) or {}):
        if kind == 'reactions':
            rc = d.get('reaction_count')
            if isinstance(rc, dict) and isinstance(rc.get('count'), (int, float)):
                values.append(int(rc['count']))
            if isinstance(d.get('i18n_reaction_count'), (int, float)):
                values.append(int(d['i18n_reaction_count']))
        elif kind == 'comments':
            cm = d.get('comments')
            if isinstance(cm, dict) and isinstance(cm.get('total_count'), (int, float)):
                values.append(int(cm['total_count']))
        elif kind == 'shares':
            sc = d.get('share_count')
            if isinstance(sc, dict) and isinstance(sc.get('count'), (int, float)):
                values.append(int(sc['count']))
            if isinstance(d.get('i18n_share_count'), (int, float)):
                values.append(int(d['i18n_share_count']))
    return max(values) if values else None


def _metric(story, kind):
    v = _metric_from_action_renderers(story, kind)
    if v is not None:
        return v
    return _metric_fallback(story, kind)


def _actor(story):
    actors = story.get('actors') or []
    a = actors[0] if actors and isinstance(actors[0], dict) else {}
    return {
        'name': a.get('name') or a.get('short_name') or '',
        'id': a.get('id') or '',
        'url': a.get('url') or '',
    }


def _story_to_row(story, source_file, friendly_name):
    try:
        ts = int(story.get('creation_time'))
        dt_utc = datetime.fromtimestamp(ts, timezone.utc)
        dt_local = dt_utc.astimezone(MEXICO_TZ)
    except Exception:
        dt_utc = None
        dt_local = None
    actor = _actor(story)
    msg = _extract_message(story)
    return {
        'fecha': dt_local.strftime('%d/%m/%Y') if dt_local else '',
        'hora': dt_local.strftime('%H:%M:%S') if dt_local else '',
        'fecha_iso': dt_local.isoformat() if dt_local else '',
        'timestamp': int(story.get('creation_time') or 0),
        'cuenta': actor['name'],
        'cuenta_id': actor['id'],
        'cuenta_url': actor['url'],
        'publicacion': msg,
        'url': story.get('permalink_url') or '',
        'post_id': str(story.get('post_id') or ''),
        'formato': _detect_format(story),
        'reacciones': _metric(story, 'reactions'),
        'comentarios': _metric(story, 'comments'),
        'compartidos': _metric(story, 'shares'),
        'menciones': _extract_mentions(story, msg),
        'consulta_graphql': friendly_name or '',
        'archivo_origen': os.path.basename(source_file),
    }


def parse_date(value):
    value = (value or '').strip()
    if not value:
        return None
    for fmt in ('%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y', '%d.%m.%Y'):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    raise ValueError('Fecha inválida. Usa DD/MM/AAAA o AAAA-MM-DD.')


def extract_har_files(paths, start_date=None, end_date=None):
    if isinstance(start_date, str):
        start_date = parse_date(start_date)
    if isinstance(end_date, str):
        end_date = parse_date(end_date)
    if start_date and end_date and start_date > end_date:
        raise ValueError('La fecha inicial no puede ser posterior a la fecha final.')

    rows_by_id = {}
    diagnostics = {
        'archivos': [],
        'entradas_har': 0,
        'solicitudes_graphql': 0,
        'solicitudes_timeline': 0,
        'chunks_json': 0,
        'historias_detectadas': 0,
        'historias_descartadas_por_actor': 0,
        'duplicados': 0,
        'errores': [],
    }

    for path in paths:
        file_diag = {'archivo': os.path.basename(path), 'entradas': 0, 'timeline': 0, 'historias': 0}
        diagnostics['archivos'].append(file_diag)
        try:
            with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
                har = json.load(f)
        except Exception as exc:
            diagnostics['errores'].append(f'{os.path.basename(path)}: {exc}')
            continue
        entries = har.get('log', {}).get('entries', []) or []
        diagnostics['entradas_har'] += len(entries)
        file_diag['entradas'] = len(entries)

        for entry in entries:
            url = entry.get('request', {}).get('url', '') or ''
            if 'graphql' not in url.lower():
                continue
            diagnostics['solicitudes_graphql'] += 1
            friendly = _friendly_name(entry)
            if 'TimelineFeed' in friendly or 'Timeline' in friendly:
                diagnostics['solicitudes_timeline'] += 1
                file_diag['timeline'] += 1
            text = _decode_response_text(entry)
            for payload in _json_chunks(text):
                diagnostics['chunks_json'] += 1
                for story in _iter_story_nodes(payload):
                    diagnostics['historias_detectadas'] += 1
                    file_diag['historias'] += 1
                    row = _story_to_row(story, path, friendly)
                    pid = row['post_id']
                    if not pid:
                        continue
                    old = rows_by_id.get(pid)
                    if old is None:
                        rows_by_id[pid] = row
                    else:
                        diagnostics['duplicados'] += 1
                        # Keep the richest version if the same story appears in multiple responses/HARs.
                        score_old = len(old.get('publicacion') or '') + sum(int(old.get(k) or 0) for k in ('reacciones','comentarios','compartidos'))
                        score_new = len(row.get('publicacion') or '') + sum(int(row.get(k) or 0) for k in ('reacciones','comentarios','compartidos'))
                        if score_new > score_old:
                            rows_by_id[pid] = row

    rows = list(rows_by_id.values())
    rows.sort(key=lambda r: r.get('timestamp') or 0)

    if start_date or end_date:
        filtered = []
        for r in rows:
            try:
                d = datetime.fromisoformat(r['fecha_iso']).date() if r.get('fecha_iso') else None
            except Exception:
                d = None
            if not d:
                continue
            if start_date and d < start_date:
                continue
            if end_date and d > end_date:
                continue
            filtered.append(r)
        rows = filtered

    diagnostics['publicaciones_finales'] = len(rows)
    if rows:
        diagnostics['fecha_minima'] = rows[0]['fecha_iso']
        diagnostics['fecha_maxima'] = rows[-1]['fecha_iso']
        diagnostics['cuentas'] = dict(Counter(r['cuenta'] or '(sin cuenta)' for r in rows))
        diagnostics['formatos'] = dict(Counter(r['formato'] for r in rows))
    else:
        diagnostics['fecha_minima'] = None
        diagnostics['fecha_maxima'] = None
        diagnostics['cuentas'] = {}
        diagnostics['formatos'] = {}
    return rows, diagnostics


COLUMNS = [
    ('Fecha', 'fecha'),
    ('Hora', 'hora'),
    ('Cuenta', 'cuenta'),
    ('Publicación', 'publicacion'),
    ('URL', 'url'),
    ('Formato', 'formato'),
    ('Reacciones', 'reacciones'),
    ('Comentarios', 'comentarios'),
    ('Compartidos', 'compartidos'),
    ('Menciones / etiquetas', 'menciones'),
    ('Post ID', 'post_id'),
    ('Cuenta ID', 'cuenta_id'),
    ('Consulta GraphQL', 'consulta_graphql'),
    ('Archivo origen', 'archivo_origen'),
]


def write_csv(rows, path):
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow([h for h, _ in COLUMNS])
        for r in rows:
            w.writerow([r.get(k, '') if r.get(k, '') is not None else '' for _, k in COLUMNS])


def _excel_col_name(n):
    s = ''
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def _xml_cell(ref, value, style=0):
    value = _clean_xml_text(value)
    # Keep everything as inline strings for portability; Excel still filters/sorts these normally.
    return f'<c r="{ref}" t="inlineStr" s="{style}"><is><t xml:space="preserve">{escape(value)}</t></is></c>'


def _sheet_xml(data, headers, widths, freeze=True, autofilter=True):
    rows_xml = []
    # Header
    cells = []
    for c, h in enumerate(headers, 1):
        cells.append(_xml_cell(f'{_excel_col_name(c)}1', h, 1))
    rows_xml.append('<row r="1" ht="28" customHeight="1">' + ''.join(cells) + '</row>')
    for ridx, row in enumerate(data, 2):
        cells = []
        for cidx, value in enumerate(row, 1):
            style = 2 if cidx in (4, 5, 10) else 0
            cells.append(_xml_cell(f'{_excel_col_name(cidx)}{ridx}', value, style))
        rows_xml.append(f'<row r="{ridx}">' + ''.join(cells) + '</row>')
    max_col = _excel_col_name(len(headers))
    cols_xml = '<cols>' + ''.join(
        f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths, 1)
    ) + '</cols>'
    pane = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' if freeze else '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    filt = f'<autoFilter ref="A1:{max_col}{max(1, len(data)+1)}"/>' if autofilter else ''
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{pane}<sheetFormatPr defaultRowHeight="15"/>{cols_xml}<sheetData>{''.join(rows_xml)}</sheetData>{filt}</worksheet>'''


def write_xlsx(rows, diagnostics, path):
    pub_headers = [h for h, _ in COLUMNS]
    pub_data = []
    for r in rows:
        pub_data.append([r.get(k, '') if r.get(k, '') is not None else '' for _, k in COLUMNS])
    pub_widths = [13, 11, 25, 80, 65, 22, 12, 12, 12, 42, 22, 22, 34, 32]

    by_date = Counter(r.get('fecha') or '(sin fecha)' for r in rows)
    by_format = Counter(r.get('formato') or '(sin formato)' for r in rows)
    summary = [
        ['Indicador', 'Valor'],
        ['Publicaciones extraídas', len(rows)],
        ['Fecha mínima', diagnostics.get('fecha_minima') or ''],
        ['Fecha máxima', diagnostics.get('fecha_maxima') or ''],
        ['Solicitudes GraphQL', diagnostics.get('solicitudes_graphql', 0)],
        ['Solicitudes timeline', diagnostics.get('solicitudes_timeline', 0)],
        ['Historias detectadas', diagnostics.get('historias_detectadas', 0)],
        ['Duplicados eliminados', diagnostics.get('duplicados', 0)],
        ['', ''],
        ['Publicaciones por fecha', ''],
    ]
    for k, v in sorted(by_date.items()):
        summary.append([k, v])
    summary += [['', ''], ['Publicaciones por formato', '']]
    for k, v in by_format.most_common():
        summary.append([k, v])

    diag_rows = [['Campo', 'Valor']]
    for k, v in diagnostics.items():
        if k == 'archivos':
            continue
        diag_rows.append([k, json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v])
    for fd in diagnostics.get('archivos', []):
        diag_rows.append(['archivo', json.dumps(fd, ensure_ascii=False)])

    sheet1 = _sheet_xml(pub_data, pub_headers, pub_widths, True, True)
    sheet2 = _sheet_xml(summary[1:], summary[0], [34, 55], True, False)
    sheet3 = _sheet_xml(diag_rows[1:], diag_rows[0], [34, 110], True, False)

    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''
    root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'''
    workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Publicaciones" sheetId="1" r:id="rId1"/><sheet name="Resumen" sheetId="2" r:id="rId2"/><sheet name="Diagnóstico" sheetId="3" r:id="rId3"/></sheets></workbook>'''
    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'''
    styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0866FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>'''

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('xl/workbook.xml', workbook)
        z.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
        z.writestr('xl/styles.xml', styles)
        z.writestr('xl/worksheets/sheet1.xml', sheet1)
        z.writestr('xl/worksheets/sheet2.xml', sheet2)
        z.writestr('xl/worksheets/sheet3.xml', sheet3)


def export_bundle(rows, diagnostics, output_dir, stem='facebook_har'):
    os.makedirs(output_dir, exist_ok=True)
    xlsx_path = os.path.join(output_dir, stem + '.xlsx')
    csv_path = os.path.join(output_dir, stem + '.csv')
    json_path = os.path.join(output_dir, stem + '_diagnostico.json')
    write_xlsx(rows, diagnostics, xlsx_path)
    write_csv(rows, csv_path)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({'diagnostico': diagnostics, 'publicaciones': rows}, f, ensure_ascii=False, indent=2)
    return xlsx_path, csv_path, json_path
