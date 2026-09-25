/**
 * Fault Log sync — paste this into your Google Sheet's Apps Script editor
 * (Extensions > Apps Script). See fault-log/SETUP.md for the full steps.
 *
 * Change SECRET below to your own passphrase, then enter the same
 * passphrase in the site's Sync settings on each device.
 */
const SECRET = 'CHANGE-ME-to-a-long-private-passphrase';

const SHEET_NAME = 'Faults';
const COLS = ['id', 'updatedAt', 'createdAt', 'deleted', 'type', 'date', 'train',
  'title', 'system', 'tcms', 'breakers', 'components', 'happened', 'steps', 'notes'];
const NUMERIC = { updatedAt: true, createdAt: true };

function doGet() {
  return ContentService.createTextOutput('Fault log sync is running.');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request' });
  }
  if (SECRET.indexOf('CHANGE-ME') === 0) return json_({ ok: false, error: 'Set SECRET in the Apps Script first' });
  if (req.key !== SECRET) return json_({ ok: false, error: 'Wrong passphrase' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const rows = sh.getDataRange().getValues().slice(1);
    const rowOf = {};
    rows.forEach((r, i) => { rowOf[r[0]] = i; });

    (req.entries || []).forEach(en => {
      if (!en || !en.id) return;
      const row = toRow_(en);
      // What Sheets will hand back on the next read: the same values without the quote prefix.
      const stored = row.map(v => typeof v === 'string' && v[0] === "'" ? v.slice(1) : v);
      const i = rowOf[en.id];
      if (i === undefined) {
        sh.appendRow(row);
        rows.push(stored);
        rowOf[en.id] = rows.length - 1;
      } else if (Number(en.updatedAt) > Number(rows[i][1])) {
        // Newest edit wins.
        sh.getRange(i + 2, 1, 1, COLS.length).setValues([row]);
        rows[i] = stored;
      }
    });

    return json_({ ok: true, entries: rows.map(fromRow_) });
  } finally {
    lock.releaseLock();
  }
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Text is stored with a leading apostrophe so Sheets keeps it exactly as typed
// (no turning "081" into 81, dates into date cells, or "=..." into formulas).
function toRow_(en) {
  return COLS.map(c => {
    if (NUMERIC[c]) return Number(en[c]) || 0;
    if (c === 'deleted') return en.deleted === true;
    const v = en[c] == null ? '' : String(en[c]);
    return v === '' ? '' : "'" + v;
  });
}

function fromRow_(r) {
  const o = {};
  COLS.forEach((c, i) => {
    let v = r[i];
    if (NUMERIC[c]) v = Number(v) || 0;
    else if (c === 'deleted') v = v === true || v === 'TRUE';
    else if (v instanceof Date) v = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    else v = v == null ? '' : String(v);
    o[c] = v;
  });
  return o;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
