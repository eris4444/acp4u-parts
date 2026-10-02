/*!
 * ACP4U Parts — dependency-free XLSX builder (with photos embedded in cells)
 * plus a tiny ZIP writer/reader. Works in the browser (window.ACPX) and in Node.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ ZIP */

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const encoder = new TextEncoder();
  const toBytes = (d) => (typeof d === 'string' ? encoder.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

  /** Store-only ZIP. files: [{name, data: string|Uint8Array}] -> array of Uint8Array chunks. */
  function zip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = encoder.encode(f.name);
      const data = toBytes(f.data);
      const crc = crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true); // stored
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + data.length;
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return parts.concat(central, [new Uint8Array(end.buffer)]);
  }

  /** Lists the entries of a ZIP: [{name, method, data (still compressed)}]. */
  function zipEntries(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP file.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP file is damaged.');
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      const start = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
      if (!name.endsWith('/')) out.push({ name, method, data: bytes.subarray(start, start + size) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /** Reads store-only ZIPs (the ones zip() writes). -> {name: Uint8Array} */
  function unzip(bytes) {
    const out = {};
    for (const e of zipEntries(bytes)) {
      if (e.method !== 0) throw new Error('This file uses compression; read it with unzipAsync.');
      out[e.name] = e.data;
    }
    return out;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed files — use Chrome or Edge.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Reads any normal ZIP, including .xlsx files saved by Excel/WPS (deflate). -> {name: Uint8Array} */
  async function unzipAsync(bytes) {
    const out = {};
    for (const e of zipEntries(bytes)) {
      if (e.method === 0) out[e.name] = e.data;
      else if (e.method === 8) out[e.name] = await inflateRaw(e.data);
      else throw new Error(`Unsupported compression in ${e.name}.`);
    }
    return out;
  }

  /* ------------------------------------------------------------------ helpers */

  const esc = (s) => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const colName = (i) => {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  };
  /** 'A' -> 0, 'N' -> 13, 'AA' -> 26 (cell refs like 'H5' are accepted too) */
  const colIndex = (ref) => {
    let n = 0;
    for (const ch of String(ref).toUpperCase().replace(/[^A-Z]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  /** Pixel width Excel uses for a column of `w` characters (Calibri 11 => max digit width 7px). */
  const colPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);
  const ptToPx = (pt) => Math.round((pt * 96) / 72);
  const EMU = 9525;

  function jpegSize(b) {
    if (!b || b[0] !== 0xFF || b[1] !== 0xD8) return null;
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xFF) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xFF) { p++; continue; }
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[p + 5] << 8) | b[p + 6], w: (b[p + 7] << 8) | b[p + 8] };
      }
      p += 2 + ((b[p + 2] << 8) | b[p + 3]);
    }
    return null;
  }

  /* ------------------------------------------------------------------ layout & styles */

  const PHOTO_SLOTS = 5;
  const COLUMNS = [
    { key: 'idx',        label: 'No.',           width: 7 },
    { key: 'customerId', label: 'Customer ID',   width: 22 },
    { key: 'platform',   label: 'Platform',      width: 13 },
    { key: 'phone',      label: 'Phone',         width: 17 },
    { key: 'location',   label: 'Country / City', width: 20 },
    { key: 'brand',      label: 'Car Brand',     width: 16 },
    { key: 'model',      label: 'Car Model',     width: 17 },
    { key: 'year',       label: 'Year',          width: 9 },
    { key: 'vin',        label: 'VIN Code',      width: 24 },
    { key: 'part',       label: 'Required Part', width: 32 },
    { key: 'status',     label: 'Status',        width: 14 },
  ];
  for (let i = 1; i <= PHOTO_SLOTS; i++) {
    COLUMNS.push({ key: 'photo' + i, label: 'Photo ' + i, width: 18, photo: true });
  }
  const FIRST_PHOTO_COL = COLUMNS.findIndex((c) => c.photo);
  const STATUS_COL = COLUMNS.findIndex((c) => c.key === 'status');
  const STATUSES = [
    { name: 'New',        font: '1F4E79', fill: 'DDEBF7' },
    { name: 'In process', font: '9C5700', fill: 'FFEB9C' },
    { name: 'Done',       font: '006100', fill: 'C6EFCE' },
    { name: 'Cancelled',  font: '6B7280', fill: 'E5E7EB' },
  ];

  const PAL = {
    navy900: '0F2741', navy700: '1E3A5F', navy500: '33507A', navyLine: '3A5A85',
    orange: 'F57C1F', text: '1F2937', line: 'C9D4E3', partText: '9A3412',
  };

  const font = ({ b, sz, color, name = 'Calibri', family = 2 }) =>
    `<font>${b ? '<b/>' : ''}<sz val="${sz}"/><color rgb="FF${color}"/><name val="${name}"/><family val="${family}"/></font>`;
  const FONTS = [
    '<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>', // 0 default (column width basis)
    font({ b: 1, sz: 16, color: 'FFFFFF' }),                         // 1 title
    font({ sz: 10, color: PAL.navy500 }),                            // 2 subtitle
    font({ b: 1, sz: 11, color: 'FFFFFF' }),                         // 3 header
    font({ sz: 11, color: PAL.text }),                               // 4 data
    font({ b: 1, sz: 11, color: PAL.navy900 }),                      // 5 row number
    font({ b: 1, sz: 10, color: PAL.text, name: 'Consolas', family: 3 }), // 6 VIN
    font({ b: 1, sz: 11, color: PAL.partText }),                     // 7 part
  ];

  const solid = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const FILLS = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    solid(PAL.navy900), // 2 title
    solid('E9EFF7'),    // 3 subtitle
    solid(PAL.navy700), // 4 header
    solid(PAL.orange),  // 5 photo header
    solid('FFFFFF'),    // 6 row odd
    solid('F3F7FC'),    // 7 row even
    solid('DCE6F2'),    // 8 number odd
    solid('CCD9EA'),    // 9 number even
    solid('FFF8F1'),    // 10 part odd
    solid('FCEEDF'),    // 11 part even
  ];

  const side = (tag, style, rgb) => (style ? `<${tag} style="${style}"><color rgb="FF${rgb}"/></${tag}>` : `<${tag}/>`);
  const border = (l, r, t, b) => `<border>${side('left', ...l)}${side('right', ...r)}${side('top', ...t)}${side('bottom', ...b)}<diagonal/></border>`;
  const THIN = ['thin', PAL.line];
  const BORDERS = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    border(THIN, THIN, THIN, THIN),                                        // 1 data
    border([], [], [], ['thin', PAL.line]),                                // 2 subtitle
    border(['thin', PAL.navyLine], ['thin', PAL.navyLine], ['thin', PAL.navyLine], ['medium', PAL.orange]), // 3 header
  ];

  // name -> [numFmtId, fontId, fillId, borderId]; index in this list == style id (s="")
  const XF_LIST = [
    ['default',    0, 0, 0, 0],
    ['title',      0, 1, 2, 0],
    ['subtitle',   0, 2, 3, 2],
    ['head',       0, 3, 4, 3],
    ['headPhoto',  0, 3, 5, 3],
    ['numOdd',     0, 5, 8, 1],
    ['numEven',    0, 5, 9, 1],
    ['textOdd',   49, 4, 6, 1],
    ['textEven',  49, 4, 7, 1],
    ['monoOdd',   49, 6, 6, 1],
    ['monoEven',  49, 6, 7, 1],
    ['partOdd',   49, 7, 10, 1],
    ['partEven',  49, 7, 11, 1],
    ['photoOdd',   0, 4, 6, 1],
    ['photoEven',  0, 4, 7, 1],
  ];
  const S = Object.fromEntries(XF_LIST.map((x, i) => [x[0], i]));

  function stylesXml() {
    const xfs = XF_LIST.map(([name, numFmt, fontId, fillId, borderId]) => {
      if (name === 'default') return '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
      return `<xf numFmtId="${numFmt}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
        `${numFmt ? ' applyNumberFormat="1"' : ''} applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">` +
        '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>';
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts>` +
      `<fills count="${FILLS.length}">${FILLS.join('')}</fills>` +
      `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      `<dxfs count="${STATUSES.length}">${STATUSES.map((st) =>
        `<dxf><font><b/><color rgb="FF${st.font}"/></font><fill><patternFill><bgColor rgb="FF${st.fill}"/></patternFill></fill></dxf>`).join('')}</dxfs>` +
      '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>';
  }

  const run = (text, { b, sz, color, name = 'Calibri' }) =>
    `<r><rPr>${b ? '<b/>' : ''}<sz val="${sz}"/><color rgb="FF${color}"/><rFont val="${name}"/><family val="2"/></rPr>` +
    `<t xml:space="preserve">${esc(text)}</t></r>`;

  /* ------------------------------------------------------------------ workbook */

  /**
   * opt.rows: [{customerId, platform, phone, location, brand, model, year, vin, part, status, ref?,
   *             photos: [{bytes: Uint8Array, w?, h?} | null] (up to 5)}]
   *   ref = the app's row id; written to a hidden "Ref" column so edits made
   *   from the file search can find the same row in the app again
   * opt.blankRows: extra empty, pre-numbered rows (for a printable/manual form)
   * opt.brand, opt.title, opt.subtitle, opt.sheetName
   * Returns an array of Uint8Array chunks (Blob-able / Buffer.concat-able).
   */
  function buildPartsXlsx(opt) {
    const rows = opt.rows || [];
    const blank = Math.max(0, opt.blankRows | 0);
    const brand = opt.brand || 'ACP4U';
    const title = opt.title || 'Customer Parts Requests';
    const subtitle = opt.subtitle || '';
    const sheetName = (opt.sheetName || 'Parts Requests').replace(/[[\]:*?/\\']/g, ' ').trim().slice(0, 31) || 'Sheet1';

    const NC = COLUMNS.length;
    const LAST = colName(NC - 1);
    const HEAD = 3;
    const FIRST = HEAD + 1;
    const total = rows.length + blank;
    const lastRow = HEAD + total;
    const anyPhoto = blank > 0 || rows.some((r) => (r.photos || []).some(Boolean));
    const withRef = rows.some((r) => r && r.ref);
    const REF = colName(NC); // hidden column right after the photos
    const LAST_ALL = withRef ? REF : LAST;
    const PHOTO_HT = 84;

    // shared strings
    const sst = { idx: new Map(), list: [], refs: 0 };
    const addStr = (s) => {
      sst.refs++;
      let i = sst.idx.get(s);
      if (i === undefined) {
        i = sst.list.length;
        sst.list.push(`<si><t xml:space="preserve">${esc(s)}</t></si>`);
        sst.idx.set(s, i);
      }
      return i;
    };
    const addRich = (xml) => { sst.refs++; sst.list.push(`<si>${xml}</si>`); return sst.list.length - 1; };

    const cStr = (ref, s, text) => (text === '' || text == null
      ? `<c r="${ref}" s="${s}"/>`
      : `<c r="${ref}" s="${s}" t="s"><v>${addStr(String(text))}</v></c>`);
    const cRich = (ref, s, xml) => `<c r="${ref}" s="${s}" t="s"><v>${addRich(xml)}</v></c>`;
    const cNum = (ref, s, n) => `<c r="${ref}" s="${s}"><v>${n}</v></c>`;
    const fillerCells = (r, s, from) => {
      let x = '';
      for (let c = from; c < NC; c++) x += `<c r="${colName(c)}${r}" s="${s}"/>`;
      return x;
    };

    const sheetRows = [];
    // 1: title
    sheetRows.push(`<row r="1" ht="40" customHeight="1">` +
      cRich('A1', S.title, run(brand, { b: 1, sz: 18, color: PAL.orange }) + run('   |   ' + title, { b: 1, sz: 15, color: 'FFFFFF' })) +
      fillerCells(1, S.title, 1) + '</row>');
    // 2: subtitle
    sheetRows.push(`<row r="2" ht="24" customHeight="1">${cStr('A2', S.subtitle, subtitle)}${fillerCells(2, S.subtitle, 1)}</row>`);
    // 3: header
    let head = '';
    COLUMNS.forEach((col, c) => { head += cStr(`${colName(c)}${HEAD}`, col.photo ? S.headPhoto : S.head, col.label); });
    if (withRef) head += cStr(`${REF}${HEAD}`, S.head, 'Ref');
    sheetRows.push(`<row r="${HEAD}" ht="30" customHeight="1">${head}</row>`);

    // data rows
    const images = []; // {row0, col0, bytes, w, h}
    const textCols = COLUMNS.slice(1, FIRST_PHOTO_COL).map((c) => c.key);
    for (let k = 0; k < total; k++) {
      const r = FIRST + k;
      const odd = k % 2 === 0;
      const rec = rows[k] || null;
      let cells = cNum(`A${r}`, odd ? S.numOdd : S.numEven, k + 1);
      textCols.forEach((key, j) => {
        const c = j + 1;
        const s = key === 'vin' ? (odd ? S.monoOdd : S.monoEven)
          : key === 'part' ? (odd ? S.partOdd : S.partEven)
            : (odd ? S.textOdd : S.textEven);
        cells += cStr(`${colName(c)}${r}`, s, rec ? (rec[key] == null ? '' : String(rec[key]).trim()) : '');
      });
      for (let i = 0; i < PHOTO_SLOTS; i++) {
        const c = FIRST_PHOTO_COL + i;
        cells += `<c r="${colName(c)}${r}" s="${odd ? S.photoOdd : S.photoEven}"/>`;
        const p = rec && rec.photos && rec.photos[i];
        if (p && p.bytes && p.bytes.length) {
          const dim = (p.w && p.h) ? { w: p.w, h: p.h } : (jpegSize(p.bytes) || { w: 1, h: 1 });
          images.push({ row0: r - 1, col0: c, bytes: p.bytes, w: dim.w, h: dim.h, name: `Row ${k + 1} - Photo ${i + 1}` });
        }
      }
      if (withRef) cells += cStr(`${REF}${r}`, odd ? S.textOdd : S.textEven, rec && rec.ref ? String(rec.ref) : '');
      let ht = PHOTO_HT;
      if (!anyPhoto) {
        // estimate wrapped lines so text-only rows stay compact but readable
        let lines = 1;
        textCols.forEach((key, j) => {
          const v = rec ? String(rec[key] || '') : '';
          const perLine = Math.max(4, Math.floor((colPx(COLUMNS[j + 1].width) - 8) / 7));
          const n = v.split('\n').reduce((a, ln) => a + Math.max(1, Math.ceil(ln.length / perLine)), 0);
          lines = Math.max(lines, n);
        });
        ht = Math.max(34, Math.min(160, lines * 15 + 10));
      }
      sheetRows.push(`<row r="${r}" ht="${ht}" customHeight="1">${cells}</row>`);
    }

    const cols = COLUMNS.map((col, c) => `<col min="${c + 1}" max="${c + 1}" width="${col.width}" customWidth="1"/>`).join('') +
      (withRef ? `<col min="${NC + 1}" max="${NC + 1}" width="18" hidden="1" customWidth="1"/>` : '');
    const qSheet = `'${sheetName.replace(/'/g, "''")}'`;
    // Status column: one colour per value (conditional formatting) + a pick list in Excel
    let statusRules = '';
    if (lastRow >= FIRST) {
      const range = `${colName(STATUS_COL)}${FIRST}:${colName(STATUS_COL)}${lastRow}`;
      statusRules =
        `<conditionalFormatting sqref="${range}">${STATUSES.map((st, i) =>
          `<cfRule type="cellIs" dxfId="${i}" priority="${i + 1}" operator="equal"><formula>"${st.name}"</formula></cfRule>`).join('')}</conditionalFormatting>` +
        `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorStyle="warning" ` +
        `errorTitle="Status" error="Use New, In process, Done or Cancelled." sqref="${range}">` +
        `<formula1>"${STATUSES.map((st) => st.name).join(',')}"</formula1></dataValidation></dataValidations>`;
    }

    const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheetPr><tabColor rgb="FF${PAL.orange}"/><pageSetUpPr fitToPage="1"/></sheetPr>` +
      `<dimension ref="A1:${LAST_ALL}${Math.max(lastRow, HEAD)}"/>` +
      '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0">' +
      `<pane ySplit="${HEAD}" topLeftCell="A${FIRST}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${FIRST}" sqref="A${FIRST}"/>` +
      '</sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      `<cols>${cols}</cols>` +
      `<sheetData>${sheetRows.join('')}</sheetData>` +
      `<autoFilter ref="A${HEAD}:${LAST}${Math.max(lastRow, HEAD)}"/>` +
      `<mergeCells count="2"><mergeCell ref="A1:${LAST}1"/><mergeCell ref="A2:${LAST}2"/></mergeCells>` +
      statusRules +
      '<printOptions horizontalCentered="1"/>' +
      '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.5" header="0.2" footer="0.25"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      `<headerFooter><oddFooter>&amp;C&amp;"Calibri,Regular"&amp;9${esc(brand)}  -  &amp;P / &amp;N</oddFooter></headerFooter>` +
      (lastRow >= FIRST ? `<ignoredErrors><ignoredError sqref="A${FIRST}:${LAST_ALL}${lastRow}" numberStoredAsText="1"/></ignoredErrors>` : '') +
      (images.length ? '<drawing r:id="rId1"/>' : '') +
      '</worksheet>';

    // drawing: every photo sits centred inside its own cell and moves/sizes with it (sort & filter safe)
    let drawingXml = '';
    let drawingRels = '';
    const media = [];
    if (images.length) {
      const cellW = colPx(COLUMNS[FIRST_PHOTO_COL].width);
      const cellH = ptToPx(PHOTO_HT);
      const pad = 5;
      let anchors = '';
      let rels = '';
      images.forEach((img, n) => {
        const scale = Math.min((cellW - 2 * pad) / img.w, (cellH - 2 * pad) / img.h);
        const w = Math.max(1, Math.floor(img.w * scale));
        const h = Math.max(1, Math.floor(img.h * scale));
        const offX = Math.floor((cellW - w) / 2);
        const offY = Math.floor((cellH - h) / 2);
        const rid = `rId${n + 1}`;
        media.push({ name: `xl/media/image${n + 1}.jpeg`, data: img.bytes });
        rels += `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${n + 1}.jpeg"/>`;
        anchors += '<xdr:twoCellAnchor editAs="twoCell">' +
          `<xdr:from><xdr:col>${img.col0}</xdr:col><xdr:colOff>${offX * EMU}</xdr:colOff><xdr:row>${img.row0}</xdr:row><xdr:rowOff>${offY * EMU}</xdr:rowOff></xdr:from>` +
          `<xdr:to><xdr:col>${img.col0}</xdr:col><xdr:colOff>${(offX + w) * EMU}</xdr:colOff><xdr:row>${img.row0}</xdr:row><xdr:rowOff>${(offY + h) * EMU}</xdr:rowOff></xdr:to>` +
          '<xdr:pic><xdr:nvPicPr>' +
          `<xdr:cNvPr id="${n + 2}" name="${esc(img.name)}" descr="${esc(img.name)}"/>` +
          '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
          `<xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
          `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="${PAL.line}"/></a:solidFill></a:ln></xdr:spPr>` +
          '</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>';
      });
      drawingXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' + anchors + '</xdr:wsDr>';
      drawingRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>';
    }

    const sstXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.refs}" uniqueCount="${sst.list.length}">` +
      sst.list.join('') + '</sst>';

    const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr/>' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15600" activeTab="0"/></bookViews>' +
      `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
      '<definedNames>' +
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${esc(qSheet)}!$A$${HEAD}:$${LAST}$${Math.max(lastRow, HEAD)}</definedName>` +
      `<definedName name="_xlnm.Print_Titles" localSheetId="0">${esc(qSheet)}!$1:$${HEAD}</definedName>` +
      '</definedNames>' +
      '<calcPr calcId="191029"/>' +
      '</workbook>';

    const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files = [
      {
        name: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
          (images.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
          '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'docProps/core.xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
          'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
          'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
          `<dc:title>${esc(brand + ' - ' + title)}</dc:title><dc:creator>${esc(brand)}</dc:creator><cp:lastModifiedBy>${esc(brand)}</cp:lastModifiedBy>` +
          `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
          '</cp:coreProperties>',
      },
      {
        name: 'docProps/app.xml',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
          'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application></Properties>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
          '</Relationships>',
      },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/styles.xml', data: stylesXml() },
      { name: 'xl/sharedStrings.xml', data: sstXml },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
    ];
    if (images.length) {
      files.push(
        {
          name: 'xl/worksheets/_rels/sheet1.xml.rels',
          data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
            '</Relationships>',
        },
        { name: 'xl/drawings/drawing1.xml', data: drawingXml },
        { name: 'xl/drawings/_rels/drawing1.xml.rels', data: drawingRels },
        ...media,
      );
    }
    return zip(files);
  }

  const API = { zip, unzip, unzipAsync, crc32, jpegSize, colName, colIndex, buildPartsXlsx, COLUMNS, PHOTO_SLOTS, STATUSES };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ACPX = API;
})(typeof self !== 'undefined' ? self : this);
