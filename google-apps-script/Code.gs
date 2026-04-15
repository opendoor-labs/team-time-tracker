// ============================================================
// Team Time Tracker — Google Apps Script (v31 — Fixes)
// Fix 1: Archive date naming (remove yesterday calc)
// Fix 2: Time values stored as text (no more 12/30/1899)
// ============================================================

function doPost(e) {
  var ss = SpreadsheetApp.openById('1qoChICfyrhWEa2loypCoQafcsoSa6cnmP4mjYOcnAKI');
  var data = JSON.parse(e.postData.contents);

  if (data.type === 'clear_reset') {
    var cfg = ss.getSheetByName('Config');
    if (cfg) {
      var current = String(cfg.getRange('B3').getValue());
      var name = String(data.name || '').trim().toLowerCase();
      var names = current.split(',').map(function (n) { return n.trim(); }).filter(function (n) { return n.toLowerCase() !== name && n !== ''; });
      cfg.getRange('B3').setValue(names.join(','));
    }
    return ContentService.createTextOutput(JSON.stringify({ "status": "ok" })).setMimeType(ContentService.MimeType.JSON);
  }

  if (data.type === 'batch') {
    if (data.live_status) { processLiveStatus(ss, data.live_status); }
    if (data.activity_logs && data.activity_logs.length > 0) {
      for (var i = 0; i < data.activity_logs.length; i++) {
        processActivityLog(ss, data.activity_logs[i]);
      }
    }
    if (data.idle_alerts && data.idle_alerts.length > 0) {
      for (var i = 0; i < data.idle_alerts.length; i++) {
        processIdleAlert(ss, data.idle_alerts[i]);
      }
    }
    if (data.shift_summary) { processShiftSummary(ss, data.shift_summary); }
    if (data.productivity_logs && data.productivity_logs.length > 0) {
      for (var i = 0; i < data.productivity_logs.length; i++) {
        processProductivityLog(ss, data.productivity_logs[i]);
      }
    }
    return ContentService.createTextOutput('OK');
  }

  if (data.type === 'live_status') {
    processLiveStatus(ss, data);
    return ContentService.createTextOutput('OK');
  }
  if (data.type === 'shift_summary') {
    processShiftSummary(ss, data);
    return ContentService.createTextOutput('OK');
  }
  if (data.type === 'idle_alert') {
    processIdleAlert(ss, data);
    return ContentService.createTextOutput('OK');
  }

  // Fallback: activity log
  processActivityLog(ss, data);
  return ContentService.createTextOutput('OK');
}

// ── LIVE STATUS ──
function processLiveStatus(ss, data) {
  var liveSheet = ss.getSheetByName('Live');
  if (!liveSheet) {
    liveSheet = ss.insertSheet('Live');
    liveSheet.appendRow(['Name', 'Date', 'Shift Start', 'Time', 'Current Activity', 'Production (min)', 'Break (min)', 'Lunch/Dinner (min)', 'Meeting (min)', 'Training (min)', 'Idle (min)', 'Break Exceeded', 'Shift Elapsed']);
    liveSheet.getRange('1:1').setFontWeight('bold');
  }
  var nameCol = liveSheet.getRange('A:A').getValues();
  var rowIndex = -1;
  for (var i = 1; i < nameCol.length; i++) {
    if (nameCol[i][0] === data.name) { rowIndex = i + 1; break; }
  }
  var rowData = [
    data.name, data.date, data.shiftStart || '', data.timestamp,
    data.currentActivity, data.productionMinutes, data.breakMinutes,
    data.lunchDinnerMinutes, data.meetingMinutes, data.trainingMinutes,
    data.idleMinutes || 0,
    data.breakExceeded ? 'YES' : 'NO', data.shiftElapsed
  ];
  if (rowIndex > 0) {
    liveSheet.getRange(rowIndex, 1, 1, 13).setValues([rowData]);
    // FIX: Force time columns to text so Sheets doesn't auto-parse as Date
    liveSheet.getRange(rowIndex, 3, 1, 2).setNumberFormat('@'); // C:Shift Start, D:Time
    liveSheet.getRange(rowIndex, 13).setNumberFormat('@');       // M:Shift Elapsed
  } else {
    liveSheet.appendRow(rowData);
    var lastRow = liveSheet.getLastRow();
    liveSheet.getRange(lastRow, 3, 1, 2).setNumberFormat('@');
    liveSheet.getRange(lastRow, 13).setNumberFormat('@');
  }
}

// ── SHIFT SUMMARY (with deduplication) ──
function processShiftSummary(ss, data) {
  var summarySheet = ss.getSheetByName('Summary');
  if (!summarySheet) {
    summarySheet = ss.insertSheet('Summary');
    summarySheet.appendRow(['Date', 'Name', 'Shift Start', 'Shift End', 'Production (min)', 'Break (min)', 'Lunch/Dinner (min)', 'Meeting (min)', 'Training (min)', 'Idle (min)', 'Break Exceeded', 'Exceeded By (min)', 'Break Not Marked (min)']);
    summarySheet.getRange('1:1').setFontWeight('bold');
  }
  var rowData = [
    data.date, data.name, data.shiftStart, data.shiftEnd,
    data.productionMinutes, data.breakMinutes, data.lunchDinnerMinutes,
    data.meetingMinutes, data.trainingMinutes, data.idleMinutes || 0,
    data.breakExceeded ? 'YES' : 'NO', data.breakExceededBy || 0,
    data.breakNotMarkedMinutes || 0
  ];
  var lastRow = summarySheet.getLastRow();
  var existingRow = -1;
  if (lastRow > 1) {
    var existing = summarySheet.getRange(2, 1, lastRow - 1, 3).getDisplayValues();
    for (var i = 0; i < existing.length; i++) {
      if (existing[i][1] === data.name && existing[i][0] === data.date && existing[i][2] === data.shiftStart) {
        existingRow = i + 2;
        break;
      }
    }
  }
  if (existingRow > 0) {
    summarySheet.getRange(existingRow, 1, 1, 13).setValues([rowData]);
    // FIX: Force Shift Start/End to text
    summarySheet.getRange(existingRow, 3, 1, 2).setNumberFormat('@');
  } else {
    summarySheet.appendRow(rowData);
    var newRow = summarySheet.getLastRow();
    summarySheet.getRange(newRow, 3, 1, 2).setNumberFormat('@');
  }
}

// ── ACTIVITY LOG ──
function processActivityLog(ss, data) {
  if (!data.activity || String(data.activity).trim() === '') return;
  var sheet = ss.getSheetByName('Sheet1');
  if (!sheet) return;
  sheet.appendRow([
    data.date, data.name, data.activity,
    data.startTime, data.endTime,
    data.durationSeconds, data.durationFormatted,
    data.breakExceeded ? 'YES' : 'NO',
    data.triggerType || 'Manual'
  ]);
  // FIX: Force Start Time / End Time to text
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 4, 1, 2).setNumberFormat('@'); // D:Start Time, E:End Time
}

// ── IDLE ALERT ──
function processIdleAlert(ss, data) {
  var idleSheet = ss.getSheetByName('Idle');
  if (!idleSheet) {
    idleSheet = ss.insertSheet('Idle');
    idleSheet.appendRow(['Date', 'Time', 'Name', 'Current Activity', 'Idle Minutes', 'Event']);
    idleSheet.getRange('1:1').setFontWeight('bold');
  }
  idleSheet.appendRow([
    data.date || '',
    data.timestamp || '',
    data.name || '',
    data.currentActivity || '',
    data.idleMinutes || 0,
    data.event || ''
  ]);
  // FIX: Force Time column to text
  var lastRow = idleSheet.getLastRow();
  idleSheet.getRange(lastRow, 2).setNumberFormat('@'); // B:Time
}

// ============================================================
// doGet — Dashboard API + backward-compatible config response
// ============================================================
function doGet(e) {
  var ss = SpreadsheetApp.openById('1qoChICfyrhWEa2loypCoQafcsoSa6cnmP4mjYOcnAKI');

  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  var callback = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : '';

  // Return list of available archive dates
  if (action === 'dates') {
    var dates = getArchiveDates();
    var jsonOutput = JSON.stringify({ dates: dates });
    if (callback) {
      return ContentService.createTextOutput(callback + '(' + jsonOutput + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(jsonOutput)
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'dashboard') {
    var result = {};
    var dateParam = (e && e.parameter && e.parameter.date) ? e.parameter.date : '';

    var today = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'MM-dd-yyyy');

    var dataSource = ss;
    var isArchive = false;

    if (dateParam && dateParam !== today && dateParam !== '') {
      var archiveSS = findArchiveByDate(dateParam);
      if (archiveSS) {
        dataSource = archiveSS;
        isArchive = true;
      } else {
        result.error = 'No archive found for ' + dateParam;
        result.live = [];
        result.summary = [];
        result.activity = [];
        result.idle = [];
        result.config = { version: '', sourceUrl: '', forceReset: '' };
        result.isArchive = true;
        result.requestedDate = dateParam;
        result.timestamp = new Date().toISOString();
        var jsonOutput = JSON.stringify(result);
        if (callback) {
          return ContentService.createTextOutput(callback + '(' + jsonOutput + ')')
            .setMimeType(ContentService.MimeType.JAVASCRIPT);
        }
        return ContentService.createTextOutput(jsonOutput)
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    // Config (always from live sheet)
    var config = ss.getSheetByName('Config');
    if (config) {
      result.config = {
        version: String(config.getRange('B1').getValue()),
        sourceUrl: String(config.getRange('B2').getValue()),
        forceReset: String(config.getRange('B3').getValue())
      };
    }

    result.live = getSheetData(dataSource, 'Live');
    result.summary = getSheetData(dataSource, 'Summary');

    if (isArchive) {
      result.activity = getSheetData(dataSource, 'Activity Log', 200);
    } else {
      result.activity = getSheetData(dataSource, 'Sheet1', 200);
    }

    result.idle = getSheetData(dataSource, 'Idle', 200);

    result.timestamp = new Date().toISOString();
    result.isArchive = isArchive;
    result.requestedDate = dateParam || today;
    result.today = today;
    result.availableDates = getArchiveDates();

    var jsonOutput = JSON.stringify(result);

    if (callback) {
      return ContentService.createTextOutput(callback + '(' + jsonOutput + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService.createTextOutput(jsonOutput)
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── BACKWARD COMPATIBLE: config for Swift app ──
  var config = ss.getSheetByName('Config');
  if (config) {
    var version = config.getRange('B1').getValue();
    var sourceUrl = config.getRange('B2').getValue();
    var forceReset = config.getRange('B3').getValue();
    return ContentService.createTextOutput(JSON.stringify({
      "version": String(version),
      "sourceUrl": String(sourceUrl),
      "forceReset": String(forceReset)
    })).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput('Team Time Tracker API is running');
}

// ── Find archive by date ──
function findArchiveByDate(dateStr) {
  var folderId = '1jNqie3mVK_7eWoLORhddTFg08f3rkPSn';
  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      if (name.indexOf('Team Tracker - ' + dateStr) === 0) {
        return SpreadsheetApp.open(file);
      }
    }
  } catch (e) {}
  return null;
}

// ── Get list of archive dates ──
function getArchiveDates() {
  var folderId = '1jNqie3mVK_7eWoLORhddTFg08f3rkPSn';
  var dates = [];
  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      var name = file.getName();
      var match = name.match(/Team Tracker - (\d{2}-\d{2}-\d{4}) \((\w+)\)/);
      if (match) {
        dates.push({
          date: match[1],
          day: match[2],
          label: match[1] + ' (' + match[2] + ')',
          fileId: file.getId()
        });
      }
    }
    dates.sort(function(a, b) {
      var da = new Date(a.date.replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$1-$2'));
      var db = new Date(b.date.replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$1-$2'));
      return db - da;
    });
  } catch (e) {}
  return dates;
}

// ── Helper: Read sheet as array of objects ──
function getSheetData(ss, sheetName, lastNRows) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0];
  var rows = data.slice(1);

  if (lastNRows && rows.length > lastNRows) {
    rows = rows.slice(rows.length - lastNRows);
  }

  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var obj = {};
    var hasData = false;
    for (var j = 0; j < headers.length; j++) {
      if (headers[j]) {
        var val = rows[i][j];
        if (val instanceof Date) {
          obj[headers[j]] = Utilities.formatDate(val, 'Asia/Kolkata', 'MM/dd/yyyy hh:mm:ss a');
        } else {
          obj[headers[j]] = val;
        }
        if (val !== '' && val !== null && val !== undefined) hasData = true;
      }
    }
    if (hasData) result.push(obj);
  }

  return result;
}

// ═══════════════════════════════════════════════════
// ARCHIVE — Runs daily at ~6 AM IST
// ═══════════════════════════════════════════════════

function archiveAndClean() {
  var ss = SpreadsheetApp.openById('1qoChICfyrhWEa2loypCoQafcsoSa6cnmP4mjYOcnAKI');
  var folderId = '1jNqie3mVK_7eWoLORhddTFg08f3rkPSn';
  var folder = DriveApp.getFolderById(folderId);

  // FIX: Use current time in PST — do NOT subtract 24 hours.
  // Trigger fires at 6 AM IST = ~5:30 PM PDT previous calendar day.
  // The shift date (April 14) IS the current PDT date at that moment.
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'America/Los_Angeles', 'MM-dd-yyyy');
  var dayName = Utilities.formatDate(now, 'America/Los_Angeles', 'EEEE');

  var liveSheet = ss.getSheetByName('Live');
  var sheet1 = ss.getSheetByName('Sheet1');
  var summarySheet = ss.getSheetByName('Summary');
  var idleSheet = ss.getSheetByName('Idle');

  var liveRows = liveSheet ? liveSheet.getLastRow() : 0;
  var sheet1Rows = sheet1 ? sheet1.getLastRow() : 0;
  var summaryRows = summarySheet ? summarySheet.getLastRow() : 0;
  var idleRows = idleSheet ? idleSheet.getLastRow() : 0;

  if (liveRows <= 1 && sheet1Rows <= 1 && summaryRows <= 1 && idleRows <= 1) { return; }

  var archiveName = 'Team Tracker - ' + dateStr + ' (' + dayName + ')';
  var archiveSS = SpreadsheetApp.create(archiveName);
  var archiveFile = DriveApp.getFileById(archiveSS.getId());
  folder.addFile(archiveFile);
  DriveApp.getRootFolder().removeFile(archiveFile);

  // FIX: Use getDisplayValues() + text format to preserve exact time strings
  // This prevents "12/30/1899" and "4/14/2026" (date-only) issues

  // Archive Live tab
  if (liveSheet && liveRows > 1) {
    var liveData = liveSheet.getRange(1, 1, liveRows, 13).getDisplayValues();
    var archiveLive = archiveSS.getSheetByName('Sheet1');
    archiveLive.setName('Live');
    archiveLive.getRange(1, 1, liveData.length, liveData[0].length).setNumberFormat('@');
    archiveLive.getRange(1, 1, liveData.length, liveData[0].length).setValues(liveData);
    archiveLive.getRange('1:1').setFontWeight('bold');
  }

  // Archive Activity Log (Sheet1)
  if (sheet1 && sheet1Rows > 1) {
    var sheet1Data = sheet1.getRange(1, 1, sheet1Rows, sheet1.getLastColumn()).getDisplayValues();
    var archiveSheet1 = archiveSS.insertSheet('Activity Log');
    archiveSheet1.getRange(1, 1, sheet1Data.length, sheet1Data[0].length).setNumberFormat('@');
    archiveSheet1.getRange(1, 1, sheet1Data.length, sheet1Data[0].length).setValues(sheet1Data);
    archiveSheet1.getRange('1:1').setFontWeight('bold');
  }

  // Archive Summary
  if (summarySheet && summaryRows > 1) {
    var summaryData = summarySheet.getRange(1, 1, summaryRows, summarySheet.getLastColumn()).getDisplayValues();
    var archiveSummary = archiveSS.insertSheet('Summary');
    archiveSummary.getRange(1, 1, summaryData.length, summaryData[0].length).setNumberFormat('@');
    archiveSummary.getRange(1, 1, summaryData.length, summaryData[0].length).setValues(summaryData);
    archiveSummary.getRange('1:1').setFontWeight('bold');
  }

  // Archive Idle
  if (idleSheet && idleRows > 1) {
    var idleData = idleSheet.getRange(1, 1, idleRows, idleSheet.getLastColumn()).getDisplayValues();
    var archiveIdle = archiveSS.insertSheet('Idle');
    archiveIdle.getRange(1, 1, idleData.length, idleData[0].length).setNumberFormat('@');
    archiveIdle.getRange(1, 1, idleData.length, idleData[0].length).setValues(idleData);
    archiveIdle.getRange('1:1').setFontWeight('bold');
  }

  // ── CLEAR SHEETS (keep headers) ──
  if (liveSheet && liveRows > 1) { liveSheet.getRange(2, 1, liveRows - 1, 13).clearContent(); }
  if (sheet1 && sheet1Rows > 1) { sheet1.getRange(2, 1, sheet1Rows - 1, sheet1.getLastColumn()).clearContent(); }
  if (summarySheet && summaryRows > 1) { summarySheet.getRange(2, 1, summaryRows - 1, summarySheet.getLastColumn()).clearContent(); }
  if (idleSheet && idleRows > 1) { idleSheet.getRange(2, 1, idleRows - 1, idleSheet.getLastColumn()).clearContent(); }
}

// ── Setup daily archive trigger (run once) ──
function setupArchiveTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'archiveAndClean') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 6 AM IST — explicit timezone to avoid ambiguity
  ScriptApp.newTrigger('archiveAndClean')
    .timeBased()
    .atHour(6)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone('Asia/Kolkata')
    .create();
}

// ── Productivity Log ──
function processProductivityLog(ss, data) {
  var team = data.team || 'Unknown';
  var sheetName = team + ' - Productivity';
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['Date', 'Name', 'Ticket/Address', 'Task', 'Market', 'Start Time', 'End Time', 'Duration (sec)', 'Notes', 'Drive Link', 'Productivity Type']);
    sheet.getRange('1:1').setFontWeight('bold');
  }
  sheet.appendRow([
    data.date || '',
    data.name || '',
    data.ticketAddress || '',
    data.task || '',
    data.market || '',
    data.startTime || '',
    data.endTime || '',
    data.durationSeconds || 0,
    data.notes || '',
    data.driveLink || '',
    data.productivityType || ''
  ]);
}

// ═══════════════════════════════════════════════════
// ONE-TIME FIX — Run this ONCE after deploying v31
// 1. Renames wrong archive "04-13-2026" → "04-14-2026"
// 2. Recreates trigger with explicit IST timezone
// 3. Sets text format on existing Live sheet time columns
// ═══════════════════════════════════════════════════
function oneTimeFix_v31() {
  var folderId = '1jNqie3mVK_7eWoLORhddTFg08f3rkPSn';
  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFiles();
  var renamed = 0;

  // 1. Rename wrongly-named archive files
  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    // Fix: "Team Tracker - 04-13-2026 (Monday)" → "Team Tracker - 04-14-2026 (Tuesday)"
    if (name === 'Team Tracker - 04-13-2026 (Monday)') {
      file.setName('Team Tracker - 04-14-2026 (Tuesday)');
      renamed++;
    }
  }

  // 2. Recreate archive trigger with explicit timezone
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'archiveAndClean') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('archiveAndClean')
    .timeBased()
    .atHour(6)
    .nearMinute(30)
    .everyDays(1)
    .inTimezone('Asia/Kolkata')
    .create();

  // 3. Fix existing Live sheet — set time columns to text format
  var ss = SpreadsheetApp.openById('1qoChICfyrhWEa2loypCoQafcsoSa6cnmP4mjYOcnAKI');
  var liveSheet = ss.getSheetByName('Live');
  if (liveSheet) {
    liveSheet.getRange('C:C').setNumberFormat('@'); // Shift Start
    liveSheet.getRange('D:D').setNumberFormat('@'); // Time
    liveSheet.getRange('M:M').setNumberFormat('@'); // Shift Elapsed
  }
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1) {
    sheet1.getRange('D:D').setNumberFormat('@'); // Start Time
    sheet1.getRange('E:E').setNumberFormat('@'); // End Time
  }
  var summarySheet = ss.getSheetByName('Summary');
  if (summarySheet) {
    summarySheet.getRange('C:C').setNumberFormat('@'); // Shift Start
    summarySheet.getRange('D:D').setNumberFormat('@'); // Shift End
  }
  var idleSheet = ss.getSheetByName('Idle');
  if (idleSheet) {
    idleSheet.getRange('B:B').setNumberFormat('@'); // Time
  }

  return 'Done! Renamed ' + renamed + ' archive file(s), recreated trigger at 6 AM IST, fixed column formats.';
}
