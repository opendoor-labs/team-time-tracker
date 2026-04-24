// ═══════════════════════════════════════════════════════════════════
//  Paste this into the Apps Script project for Team Time Tracker.
//  Where: https://script.google.com/u/0/home/projects/1DcpjvFta4K4YUmCvbO0ugVuaGQgcwPBGTWOTana8Iz9qwsTNlvzC4F5C/edit
//
//  What it does: adds an `action=logError` handler. Every JS error
//  from the 115 Mac apps and every Swift network failure lands in
//  the Errors tab so Arun sees problems before users report them.
//
//  Schema of the Errors tab (already created):
//    A=Timestamp (IST) · B=User · C=Version · D=Source (js|swift)
//    E=Kind · F=Message · G=URL/Context · H=Stack
// ═══════════════════════════════════════════════════════════════════

// ── 1. Add this action branch inside the existing doPost() router ──
//    Find the switch/if-else that dispatches on e.parameter.action or
//    body.action, and add this case. Example structure:
//
//    function doPost(e) {
//      var body = JSON.parse(e.postData.contents || '{}');
//      switch (body.action) {
//        case 'heartbeat':      return handleHeartbeat(body);
//        case 'logTask':        return handleLogTask(body);
//        case 'logError':       return handleLogError(body);   // ← ADD THIS
//        ...
//      }
//    }

function handleLogError(body) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName('Errors');
    if (!sh) {
      // Auto-create the tab + header row if someone deletes it.
      sh = ss.insertSheet('Errors');
      sh.appendRow([
        'Timestamp (IST)', 'User', 'Version', 'Source',
        'Kind', 'Message', 'URL/Context', 'Stack'
      ]);
      sh.setFrozenRows(1);
    }

    var nowIST = Utilities.formatDate(
      new Date(), 'Asia/Kolkata', 'yyyy-MM-dd HH:mm:ss'
    );

    sh.appendRow([
      nowIST,
      String(body.user || '').slice(0, 80),
      String(body.version || '').slice(0, 20),
      String(body.source || 'js').slice(0, 10),
      String(body.kind || 'error').slice(0, 40),
      String(body.message || '').slice(0, 500),
      String(body.context || '').slice(0, 200),
      String(body.stack || '').slice(0, 1500)
    ]);

    // Cap the tab at 2,000 rows so it never slows down the sheet.
    var rows = sh.getLastRow();
    if (rows > 2001) {
      sh.deleteRows(2, rows - 2001);  // keep header + latest 2,000
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    // Never crash the request — telemetry must never break the app.
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── 2. (Optional but recommended) Daily Slack digest ─────────────
//    Wire a time-driven trigger to run dailyErrorDigest() at 9 AM IST.
//    It counts yesterday's errors grouped by kind and pastes a summary
//    into the top cell so you see it when you open the sheet.

function dailyErrorDigest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Errors');
  if (!sh || sh.getLastRow() < 2) return;

  var yest = Utilities.formatDate(
    new Date(Date.now() - 86400000), 'Asia/Kolkata', 'yyyy-MM-dd'
  );
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
  var counts = {};
  var users = {};
  data.forEach(function (r) {
    if (String(r[0]).indexOf(yest) !== 0) return;
    var kind = r[4] || 'error';
    counts[kind] = (counts[kind] || 0) + 1;
    users[r[1]] = true;
  });

  var total = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);
  var summary = total === 0
    ? 'No errors yesterday 🎉'
    : total + ' errors from ' + Object.keys(users).length + ' users: ' +
      Object.keys(counts).map(function (k) { return k + '×' + counts[k]; }).join(', ');

  // Write to Config!B9 so it shows up in the admin view.
  var config = ss.getSheetByName('Config');
  if (config) config.getRange('B9').setValue(yest + ' → ' + summary);
}
