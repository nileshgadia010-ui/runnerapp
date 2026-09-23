const ExcelJS = require('exceljs');

/**
 * Builds the Excel files the office downloads.
 *
 * The shape is always the same and it is deliberate: a block of headline numbers at the top,
 * then the rows that produced them. Somebody opening the file should get the answer in the
 * first screen without scrolling or reading a formula, and still be able to sort, filter and
 * check every figure underneath.
 *
 * A plain CSV cannot do the top half at all, which is why these are real workbooks.
 */

const INK = 'FF101828';
const CRIMSON = 'FFC8102E';
const MUTED = 'FF667085';
const LINE = 'FFE3E8EF';
const MIST = 'FFF4F6F9';

function newBook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IBS Control Room';
  wb.created = new Date();
  return wb;
}

/**
 * Writes the title, the period it covers, and the headline figures.
 * Returns the row number where the data table should start.
 */
function header(ws, title, subtitle, tiles, width) {
  ws.mergeCells(1, 1, 1, width);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { size: 20, bold: true, color: { argb: INK } };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, width);
  const s = ws.getCell(2, 1);
  s.value = subtitle;
  s.font = { size: 11, color: { argb: MUTED } };
  ws.getRow(2).height = 18;

  // The headline numbers. Each tile is two cells stacked: a big figure over its label.
  let col = 1;
  const span = Math.max(2, Math.floor(width / Math.max(1, tiles.length)));

  tiles.forEach(tile => {
    const last = Math.min(width, col + span - 1);

    ws.mergeCells(4, col, 4, last);
    const v = ws.getCell(4, col);
    v.value = tile.value;
    v.font = { size: 22, bold: true, color: { argb: tile.alert ? CRIMSON : INK } };
    v.alignment = { horizontal: 'left', vertical: 'middle' };

    ws.mergeCells(5, col, 5, last);
    const l = ws.getCell(5, col);
    l.value = String(tile.label).toUpperCase();
    l.font = { size: 9, bold: true, color: { argb: MUTED } };

    [4, 5].forEach(r => {
      for (let c = col; c <= last; c++) {
        ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MIST } };
      }
    });
    col = last + 1;
  });

  ws.getRow(4).height = 30;
  ws.getRow(5).height = 16;
  return 7;   // one blank row, then the table
}

/** Writes the table and returns the sheet, with filters and frozen headings already on. */
function table(ws, startRow, columns, rows) {
  const head = ws.getRow(startRow);
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.label;
    cell.font = { size: 10, bold: true, color: { argb: INK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MIST } };
    cell.border = { bottom: { style: 'thin', color: { argb: LINE } } };
    cell.alignment = { vertical: 'middle' };
  });
  head.height = 22;

  rows.forEach((row, n) => {
    const r = ws.getRow(startRow + 1 + n);
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      const raw = row[c.key];
      cell.value = raw === undefined || raw === null ? '' : raw;
      cell.font = { size: 10 };
      cell.border = { bottom: { style: 'hair', color: { argb: LINE } } };
      if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.align) cell.alignment = { horizontal: c.align };
      // Anything the office should notice is coloured rather than annotated.
      if (c.flag && c.flag(row)) cell.font = { size: 10, bold: true, color: { argb: CRIMSON } };
    });
  });

  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 16; });

  // Sortable and filterable the moment it opens, with the headings pinned.
  if (rows.length) {
    ws.autoFilter = {
      from: { row: startRow, column: 1 },
      to: { row: startRow + rows.length, column: columns.length }
    };
  }
  ws.views = [{ state: 'frozen', ySplit: startRow }];
  return ws;
}

/** Streams a finished workbook to the browser as a download. */
async function send(res, wb, filename) {
  res.setHeader('Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  await wb.xlsx.write(res);
  res.end();
}

/* ---- small formatters, so every sheet reads the same way ---- */

const IST = d => d ? new Date(new Date(d).getTime() + 330 * 60000) : null;

function clock(d) {
  const t = IST(d);
  if (!t) return '';
  let h = t.getUTCHours(), m = String(t.getUTCMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ap;
}

function day(d) {
  const t = IST(d);
  if (!t) return '';
  return t.toISOString().slice(0, 10);
}

function hm(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
}

module.exports = { newBook, header, table, send, clock, day, hm };
