import csv
import io
import json
import os
import tempfile
import zipfile
from collections import Counter
from datetime import datetime
from xml.sax.saxutils import escape

AI_COLUMNS = [
    ('Fecha', 'fecha'),
    ('Hora', 'hora'),
    ('Cuenta', 'cuenta'),
    ('Pertenece a', 'pertenencia_ia'),
    ('Confianza IA', 'confianza_ia'),
    ('Motivo IA', 'motivo_ia'),
    ('Tema / proyecto IA', 'tema_ia'),
    ('Publicación', 'publicacion'),
    ('URL', 'url'),
    ('Formato', 'formato'),
    ('Reacciones', 'reacciones'),
    ('Comentarios', 'comentarios'),
    ('Compartidos', 'compartidos'),
    ('Menciones / etiquetas', 'menciones'),
    ('Método clasificación', 'metodo_clasificacion'),
    ('Post ID', 'post_id'),
    ('Cuenta ID', 'cuenta_id'),
    ('Consulta GraphQL', 'consulta_graphql'),
    ('Archivo origen', 'archivo_origen'),
]


def _clean(value):
    if value is None:
        return ''
    s = str(value)
    return ''.join(ch for ch in s if ch in '\t\n\r' or ord(ch) >= 32)[:32760]


def _col(n):
    s = ''
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def _cell(ref, value, style=0):
    return f'<c r="{ref}" t="inlineStr" s="{style}"><is><t xml:space="preserve">{escape(_clean(value))}</t></is></c>'


def _sheet(data, headers, widths, wrap_cols=None):
    wrap_cols = set(wrap_cols or [])
    rows = []
    rows.append('<row r="1" ht="28" customHeight="1">' + ''.join(
        _cell(f'{_col(i)}1', h, 1) for i, h in enumerate(headers, 1)
    ) + '</row>')
    for ri, row in enumerate(data, 2):
        cells = []
        for ci, val in enumerate(row, 1):
            style = 2 if ci in wrap_cols else 0
            cells.append(_cell(f'{_col(ci)}{ri}', val, style))
        rows.append(f'<row r="{ri}">' + ''.join(cells) + '</row>')
    max_col = _col(len(headers))
    cols_xml = '<cols>' + ''.join(
        f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>'
        for i, w in enumerate(widths, 1)
    ) + '</cols>'
    filt = f'<autoFilter ref="A1:{max_col}{max(1, len(data)+1)}"/>'
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>{cols_xml}<sheetData>{''.join(rows)}</sheetData>{filt}</worksheet>'''


def xlsx_bytes(rows, diagnostics=None):
    diagnostics = diagnostics or {}
    headers = [h for h, _ in AI_COLUMNS]
    data = [[r.get(k, '') if r.get(k) is not None else '' for _, k in AI_COLUMNS] for r in rows]
    widths = [13, 11, 24, 16, 13, 42, 32, 80, 62, 20, 12, 12, 12, 42, 22, 22, 22, 34, 32]

    by_belongs = Counter(r.get('pertenencia_ia') or '(sin clasificar)' for r in rows)
    by_format = Counter(r.get('formato') or '(sin formato)' for r in rows)

    # Cada publicación extraída representa una mención. Agrupamos por mes
    # y además desglosamos la pertenencia para facilitar el reporte mensual.
    monthly = {}
    month_names = {
        1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril',
        5: 'Mayo', 6: 'Junio', 7: 'Julio', 8: 'Agosto',
        9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre'
    }
    for r in rows:
        raw_date = str(r.get('fecha') or '').strip()
        dt = None
        for fmt in ('%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y'):
            try:
                dt = datetime.strptime(raw_date, fmt)
                break
            except ValueError:
                pass
        if not dt:
            continue
        key = (dt.year, dt.month)
        rec = monthly.setdefault(key, {
            'Propia': 0, 'Gobierno': 0, 'Gobernador': 0,
            'Sin clasificar': 0, 'Total': 0
        })
        belongs = str(r.get('pertenencia_ia') or '').strip()
        if belongs in ('Propia', 'Gobierno', 'Gobernador'):
            rec[belongs] += 1
        else:
            rec['Sin clasificar'] += 1
        rec['Total'] += 1

    monthly_rows = []
    for (year, month), rec in sorted(monthly.items()):
        monthly_rows.append([
            f'{month_names[month]} {year}',
            rec['Propia'], rec['Gobierno'], rec['Gobernador'],
            rec['Sin clasificar'], rec['Total']
        ])

    summary = [
        ['Indicador', 'Valor'],
        ['Publicaciones / menciones totales', len(rows)],
        ['Propia', by_belongs.get('Propia', 0)],
        ['Gobierno', by_belongs.get('Gobierno', 0)],
        ['Gobernador', by_belongs.get('Gobernador', 0)],
        ['Confianza promedio', round(sum(float(r.get('confianza_ia') or 0) for r in rows) / len(rows), 1) if rows else 0],
        ['Meses incluidos', len(monthly_rows)],
        ['', ''],
        ['Formato', 'Publicaciones'],
    ] + [[k, v] for k, v in by_format.most_common()]

    diag_rows = [['Campo', 'Valor']]
    for k, v in diagnostics.items():
        diag_rows.append([k, json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v])

    sheet1 = _sheet(data, headers, widths, wrap_cols={6,7,8,9,14})
    sheet2 = _sheet(summary[1:], summary[0], [34, 60], wrap_cols={2})
    sheet3 = _sheet(diag_rows[1:], diag_rows[0], [38, 110], wrap_cols={2})
    monthly_headers = ['Mes', 'Propia', 'Gobierno', 'Gobernador', 'Sin clasificar', 'Total de menciones']
    sheet4 = _sheet(monthly_rows, monthly_headers, [24, 14, 14, 14, 16, 20])

    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'''
    root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'''
    workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Publicaciones" sheetId="1" r:id="rId1"/><sheet name="Resumen" sheetId="2" r:id="rId2"/><sheet name="Diagnóstico" sheetId="3" r:id="rId3"/><sheet name="Menciones por mes" sheetId="4" r:id="rId4"/></sheets></workbook>'''
    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'''
    styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0866FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>'''

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('xl/workbook.xml', workbook)
        z.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
        z.writestr('xl/styles.xml', styles)
        z.writestr('xl/worksheets/sheet1.xml', sheet1)
        z.writestr('xl/worksheets/sheet2.xml', sheet2)
        z.writestr('xl/worksheets/sheet3.xml', sheet3)
        z.writestr('xl/worksheets/sheet4.xml', sheet4)
    return buf.getvalue()


def csv_bytes(rows):
    s = io.StringIO(newline='')
    w = csv.writer(s)
    w.writerow([h for h, _ in AI_COLUMNS])
    for r in rows:
        w.writerow([r.get(k, '') if r.get(k) is not None else '' for _, k in AI_COLUMNS])
    return ('\ufeff' + s.getvalue()).encode('utf-8')
