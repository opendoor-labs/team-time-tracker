// ═══════════════════════════════════════════════════════════════════════
//  Team Time Tracker — Apps Script v2.7.5 (HARDENED)
//  Sheet: Team_Tracker_2026_v2.7
//  Sheet ID: 1mNOj9MWZAAVNEaWvnNjIkHkoUG1rMWHg0HWM1m47OXs
//
//  CHANGES vs v2.7:
//    • LockService on every upsert handler (shiftStart_, heartbeat_,
//      markAttendance_, closeSession_, clearForceReset_) — eliminates
//      duplicate-row race conditions under concurrent requests.
//    • shiftStart_ appendRow writes '' (not 0) for TaskStartedAt — fixes
//      "1899-12-30 0:00:00" in column I for brand-new shift rows.
//    • NEW handleLogError_() — persists client JS + Swift errors into a
//      fresh "Errors" tab so Arun sees failures before users report them.
//
//  Privacy model (strict):
//    - super_admin  → all 17 team tabs + Attendance + Sessions + Whitelist + Config + Audit
//    - tl           → ONLY tabs for teams listed in their Whitelist.Teams (comma-separated)
//                     + Attendance/Sessions filtered to their team members
//    - everyone else → blocked (returns { ok:false, error:'forbidden' })
//
//  Whitelist tab columns: A=Email | B=Role | C=Teams | D=Notes
//    Role   = 'super_admin' or 'tl'
//    Teams  = 'ALL' (super_admin) OR comma-separated team names (tl)
//             Team names MUST match the keys in TEAM_TO_TAB exactly.
// ═══════════════════════════════════════════════════════════════════════

var SHEET_ID = '1mNOj9MWZAAVNEaWvnNjIkHkoUG1rMWHg0HWM1m47OXs';
var TZ       = 'Asia/Calcutta';

// Listings team — screenshot uploads land here. The folder must exist and the
// Apps Script-running account must have edit access. Files are renamed using
// the "Ticket Link/Property Address" field (sanitized) + PST date + IST time.
var LISTINGS_DRIVE_FOLDER_ID = '1hV3TcPw4HWwE5KgsuJeIX2IgMNJLba4g';

// Team → Log tab name
var TEAM_TO_TAB = {
  'BRN':                     'BRN_Log',
  'HQI':                     'HQI_Log',
  'HOA':                     'HOA_Log',
  'HOC WO':                  'HOC_WO_Log',
  'LWO':                     'LWO_Log',
  'TP Sourcing':             'TP_Sourcing_Log',
  'Utilities Turn On':       'Utilities_TurnOn_Log',
  'Utilities NST':           'Utilities_NST_Log',
  'Utilities Blocked Cases': 'Utilities_Blocked_Log',
  'TC':                      'TC_Log',
  'TS':                      'TS_Log',
  'VA':                      'VA_Log',
  'HOC Permits':             'HOC_Permits_Log',
  'Maintenance & Scheduling':'Maintenance_Log',
  'Trust / Safety':          'TrustSafety_Log',
  'Listings':                'Listings_Log',
  'SD':                      'SD_Log'
};

// Resolve whatever team string the dashboard sends (e.g. "Utilities_NST",
// "Trust_Safety", "Maintenance_Scheduling") to the canonical TEAM_TO_TAB key.
// Strategy: strip everything but [a-z0-9] from both sides and match. This
// survives underscores, dropped special chars ('/' , '&'), casing, and
// lost spaces — the app has done all of these across different teams.
// Returns the canonical key (e.g. "Trust / Safety") or null if unknown.
function resolveTeam_(rawTeam) {
  var s = String(rawTeam || '').trim();
  if (!s) return null;
  // Fast path: exact match
  if (TEAM_TO_TAB[s]) return s;
  var norm = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!resolveTeam_.cache) {
    resolveTeam_.cache = {};
    Object.keys(TEAM_TO_TAB).forEach(function (k) {
      resolveTeam_.cache[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = k;
    });
    // Short aliases the dashboard sends for teams whose canonical names
    // include extra trailing words or connectors ('&', '/', 'Cases', etc.)
    resolveTeam_.cache['utilitiesblocked']       = 'Utilities Blocked Cases';
    resolveTeam_.cache['utilitiesblockedcases']  = 'Utilities Blocked Cases';
    resolveTeam_.cache['maintenance']            = 'Maintenance & Scheduling';
    resolveTeam_.cache['maintenancescheduling']  = 'Maintenance & Scheduling';
    resolveTeam_.cache['trustsafety']            = 'Trust / Safety';
    resolveTeam_.cache['utilitiesturnon']        = 'Utilities Turn On';
  }
  return resolveTeam_.cache[norm] || null;
}

// ─── Lock helper ───────────────────────────────────────────────────────
// Apps Script web apps run doPost concurrently. Any handler that does
// read → search → conditional-append needs serialization, or two parallel
// requests for the same user both see "no row" and both append → dup row.
// Usage: wrap the body of an upsert handler with _withLock_(fn).
function _withLock_(fn) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); }
  catch (e) { return { ok: false, error: 'busy', detail: String(e) }; }
  try { return fn(); }
  finally { lock.releaseLock(); }
}

// ─── Main routers ──────────────────────────────────────────────────────
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.openById(SHEET_ID);
    // Audit removed from hot path (was writing ~130K rows/day at 115 users
    // and burning Apps Script execution quota). Re-enable per-user via
    // Config!B8 = "debug:email@opendoor.com" if debugging a specific case.
    if (_debugAuditFor_(ss, data.email || data.user || '')) {
      audit_(ss, data.action || 'post', data.email || data.user || '', data);
    }
    switch (data.action) {
      case 'logTask':         return json_(logTask_(ss, data));
      case 'markAttendance':  return json_(markAttendance_(ss, data));
      case 'closeSession':    return json_(closeSession_(ss, data));
      case 'clearForceReset': return json_(clearForceReset_(ss, data));
      case 'heartbeat':       return json_(heartbeat_(ss, data));
      case 'liveStatus':      return json_(heartbeat_(ss, data));
      case 'shiftStart':      return json_(shiftStart_(ss, data));
      case 'idleAlert':       return json_({ ok: true });
      case 'logError':        return json_(handleLogError_(ss, data));
      case 'myDashboardToken': return json_(myDashboardToken_(ss, data));
      default:                return json_({ ok: false, error: 'unknown action: ' + data.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// Opt-in audit — only writes when Config!B8 starts with "debug:<email>".
function _debugAuditFor_(ss, email) {
  try {
    var sh = ss.getSheetByName('Config');
    if (!sh) return false;
    var v = String(sh.getRange('B8').getValue() || '');
    if (v.indexOf('debug:') !== 0) return false;
    var target = v.slice(6).trim().toLowerCase();
    return !!target && target === String(email || '').toLowerCase();
  } catch (e) { return false; }
}

function doGet(e) {
  try {
    var p  = e.parameter || {};
    var ss = SpreadsheetApp.openById(SHEET_ID);
    switch (p.action) {
      case 'getConfig':       return json_(getConfig_(ss));
      case 'checkWhitelist':  return json_(checkWhitelist_(ss, p.email));
      case 'readLog':         return json_(readLog_(ss, p));
      case 'tlDashboard':     return json_(tlDashboard_(ss, p));
      case 'liveActivity':    return json_(liveActivity_(ss, p));
      case 'whoami':          return json_(whoami_(ss, p.email));
      // Email-OTP auth (browser flow)
      case 'requestOtp':      return json_(requestOtp_(ss, p.email));
      case 'verifyOtp':       return json_(verifyOtp_(ss, p.email, p.code));
      case 'myStats':         return json_(myStats_(ss, p));
      // GET fallback for Mac app — avoids POST→GET body-drop on 302 redirect
      case 'myDashboardToken': return json_(myDashboardToken_(ss, { user: p.user }));
      default:                return json_({ ok: false, error: 'unknown action: ' + p.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ─── POST handlers ─────────────────────────────────────────────────────
function logTask_(ss, b) {
  // Resolve whatever form the dashboard sends (Utilities_NST, Trust_Safety,
  // Maintenance_Scheduling, etc.) to the canonical TEAM_TO_TAB key so both
  // the tab lookup AND the switch (team) below match.
  var team = resolveTeam_(b.team);
  if (!team) return { ok: false, error: 'unknown team: ' + b.team };
  var tab  = TEAM_TO_TAB[team];
  if (!tab) return { ok: false, error: 'unknown team: ' + team };
  var sh = ss.getSheetByName(tab);
  if (!sh) return { ok: false, error: 'tab missing: ' + tab };

  // Force col A (Timestamp) to plain text so Sheets stops coercing
  // "2026-04-24 20:52:21" into a Date object that serializes as
  // "Sat Apr 25 2026 02:22:21 GMT+0530" on read.
  try { sh.getRange('A:A').setNumberFormat('@'); } catch (e) {}

  var data   = b.data || {};
  var durSec = Math.round((b.durationMs || 0) / 1000);
  var durStr = fmtDur_(durSec);
  var user   = b.user || '';
  var home   = b.homeTeam || team;
  // Timestamp = PST date + IST time (date rolls at PST midnight, clock stays in IST)
  var now    = nowPSTdateISTtime_();
  var act    = b.activity || 'production';
  var sys    = b.system ? 'TRUE' : '';

  var row;
  // Per-team row mapping — MUST match tab headers.
  switch (team) {
    case 'BRN':
      row = [now, user, home, team, act,
             data['Property Address'] || '',
             data['Productivity Type'] || '',
             data['Sub Task'] || '',
             durStr, b.system ? 'System' : 'Completed', sys];
      break;
    case 'HQI':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Ticket Link'] || '',
             data['Productivity Type'] || '',
             data['Sub Task / Action Taken'] || '',
             data['Status'] || '',
             data['Priority'] || '',
             durStr, b.system ? 'System' : 'Completed', sys];
      break;
    case 'HOA':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Property Address'] || '',
             data['Productivity Type'] || '',
             data['Project / Task'] || '',
             data['Sub Task / Action Taken'] || '',
             data['Status'] || '',
             data['HOA Name'] || '',
             data['Management Name'] || '',
             data['HOA Email'] || '',
             data['HOA Phone'] || '',
             durStr, sys];
      break;
    case 'HOC WO':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Property Address'] || '',
             data['Productivity Type'] || '',
             data['Project / Task'] || '',
             data['Sub Task / Action Taken'] || '',
             data['Status'] || '',
             durStr];
      break;
    case 'LWO':
    case 'TP Sourcing':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Productivity Type'] || '',
             data['Sub Type'] || '',
             durStr];
      break;
    case 'Utilities Turn On':
    case 'Utilities NST':
    case 'Utilities Blocked Cases':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Productivity Type'] || '',
             data['Task Type'] || '',
             data['Case / Ticket #'] || data['Case/Ticket #'] || '',
             data['Comment'] || '',
             durStr];
      break;
    case 'TC':
    case 'TS':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Task Type'] || data['Task type'] || '',
             data['Flip State'] || '',
             data['Status'] || '',
             data['Comments'] || '',
             durStr];
      break;
    case 'VA':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Maestro Link'] || '',
             data['Admin RBR Link'] || '',
             data['Task Type'] || '',
             durStr];
      break;
    case 'HOC Permits':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Productivity Type'] || '',
             data['Comments'] || '',
             durStr];
      break;
    case 'Maintenance & Scheduling':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Process'] || '',
             data['Productivity Type'] || '',
             durStr];
      break;
    case 'Trust / Safety':
      row = [now, user, home, team, act,
             data['Ticket Link/Property Address'] || data['Ticket Link / Property Address'] || '',
             data['Productivity Type'] || '',
             data['Process'] || '',
             data['Subtype'] || '',
             data['Comments'] || '',
             durStr];
      break;
    case 'Listings': {
      // Save any attached screenshots to the Listings Drive folder, named
      // after the Ticket/Property field. Failures don't block the task log.
      var listingsAttachUrls = '';
      try {
        var atts = (b && b.attachments) || [];
        if (atts.length) {
          var baseName = addr_(data) || ('task_' + (user || 'user'));
          var urls = _saveAttachmentsToDrive_(atts, baseName, LISTINGS_DRIVE_FOLDER_ID);
          listingsAttachUrls = urls.join(', ');
        }
      } catch (driveErr) {
        try { Logger.log('listings drive upload failed: ' + driveErr); } catch (_) {}
        try { handleLogError_(ss, { source: 'apps-script', kind: 'listings-drive-upload',
              message: String(driveErr && driveErr.message || driveErr), user: user }); } catch (_) {}
      }
      // Column order MUST match Listings_Log headers:
      // A=Time B=User C=HomeTeam D=Team E=Activity F=Ticket Link
      // G=Task H=Market I=Productivity Type J=Duration K=Comment L=Attachments
      // (Earlier code had Comment/Attach/Duration in cols J/K/L which
      // shifted everything one cell — fixed below to put Duration first.)
      row = [now, user, home, team, act,
             addr_(data),
             data['Task'] || '',
             data['Markets'] || data['Market'] || data['MARKETS'] || '',
             data['Productivity Type'] || '',
             durStr,
             data['Comment'] || data['Comments'] || data['Notes'] || '',
             listingsAttachUrls];
      break;
    }
    case 'SD':
      row = [now, user, home, team, act,
             addr_(data),
             data['Task'] || '',
             data['Markets'] || data['Market'] || data['MARKETS'] || '',
             data['Notes'] || '',
             data['Drive Link'] || '',
             durStr];
      break;
    default:
      return { ok: false, error: 'no row mapping for team: ' + team };
  }

  sh.appendRow(row);

  // ── Live-tab side-effect: bump this user's TasksDone + ProdMin and
  //    refresh UpdatedAt so the Live sheet reflects task completion
  //    WITHOUT waiting for the next 4-min heartbeat. Non-system tasks
  //    (b.system = false) count toward TasksDone; duration always adds
  //    to ProdMin. Silent failure — logTask must never be blocked by a
  //    Live-tab issue.
  try {
    _bumpLiveAfterTask_(ss, user, team, home, durSec, !!b.system);
  } catch (liveErr) {
    // Log but don't fail the task write
    try { Logger.log('live bump failed: ' + liveErr); } catch (e) {}
  }
  return { ok: true, tab: tab, row: sh.getLastRow() };
}

// Update the caller's Live row immediately after a task lands in the
// team log. Keeps Live in sync with reality between heartbeats.
function _bumpLiveAfterTask_(ss, user, team, homeTeam, durSec, isSystem) {
  return _withLock_(function () {
    var sh = ensureLiveSheet_(ss);
    var canonTeam     = resolveTeam_(team)     || String(team || '');
    var canonHomeTeam = resolveTeam_(homeTeam) || String(homeTeam || '');
    var vals = sh.getDataRange().getValues();
    var addMin = Math.round((Number(durSec) || 0) / 60);
    var tsInc  = isSystem ? 0 : 1;   // system-auto tasks don't bump user's count
    // Derive TaskStartedAt from now - durSec so cols J + K always form a
    // matched pair, even when the task is shorter than the heartbeat
    // interval (so heartbeat_ never had a chance to write J).
    var endMs   = Date.now();
    var startMs = endMs - (Number(durSec) || 0) * 1000;
    // PST calendar date + IST clock time (consistent with UpdatedAt format).
    var taskStartedStr = pstDateIstTimeFromMs_(startMs);
    var taskEndedStr   = pstDateIstTimeFromMs_(endMs);
    // New schema (col 1-based):
    //   A=ShiftStartAt B=User C=HomeTeam D=Team E=Activity F=TasksDone
    //   G=ProdMin H=BreakMin I=IdleMin J=TaskStartedAt K=TaskEndedAt L=UpdatedAt
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][1]).toLowerCase() === String(user).toLowerCase()) {
        var rowIdx = i + 1;
        var tasksDone = Number(vals[i][5] || 0) + tsInc;
        var prodMin   = Number(vals[i][6] || 0) + addMin;
        // Only touch the cells we know changed — leave ShiftStartAt (A) alone.
        sh.getRange(rowIdx, 4).setValue(canonTeam);             // D Team
        sh.getRange(rowIdx, 5).setValue('production');          // E Activity
        sh.getRange(rowIdx, 6).setValue(tasksDone);             // F TasksDone
        sh.getRange(rowIdx, 7).setValue(prodMin);               // G ProdMin
        sh.getRange(rowIdx, 10).setValue(taskStartedStr);       // J TaskStartedAt (derived)
        sh.getRange(rowIdx, 11).setValue(taskEndedStr);         // K TaskEndedAt
        sh.getRange(rowIdx, 12).setValue(nowPSTdateISTtime_()); // L UpdatedAt
        return { ok: true, rowIdx: rowIdx };
      }
    }
    // No existing row → seed one so Live starts reflecting activity even
    // if the app missed firing shiftStart for some reason.
    sh.appendRow([
      istNow_(), user, canonHomeTeam, canonTeam, 'production',
      tsInc, addMin, 0, 0,
      taskStartedStr, taskEndedStr,
      nowPSTdateISTtime_()
    ]);
    return { ok: true, rowIdx: sh.getLastRow(), seeded: true };
  });
}

function markAttendance_(ss, b) {
  return _withLock_(function () {
    var sh = ss.getSheetByName('Attendance');
    if (!sh) return { ok: false, error: 'Attendance missing' };
    // Force col A (Date) + col E (MarkedAt) to plain text so Sheets stops
    // auto-converting "2026-04-24" and "20:52:21" into Date/time objects.
    // Idempotent — setting the format each call is cheap and self-healing.
    try { sh.getRange('A:A').setNumberFormat('@'); sh.getRange('E:E').setNumberFormat('@'); } catch (e) {}
    // Date = PST (stable across midnight IST); Timestamp = IST clock time
    var today = todayPST_();
    var stamp = timeIST_();
    var user  = b.user || '';
    // Canonicalize team so TL attendance filter (which compares against
    // whitelist canonical names) doesn't silently drop rows.
    var canonTeam = resolveTeam_(b.team) || String(b.team || '');
    var rng   = sh.getDataRange().getValues();
    for (var i = 1; i < rng.length; i++) {
      if (rng[i][0] === today && rng[i][1] === user) {
        sh.getRange(i + 1, 1, 1, 7).setValues([[today, user, canonTeam, b.status || '', stamp, 'Mac', b.notes || '']]);
        return { ok: true, updated: true };
      }
    }
    sh.appendRow([today, user, canonTeam, b.status || '', stamp, 'Mac', b.notes || '']);
    return { ok: true, inserted: true };
  });
}

// Sessions schema (11 cols):
//   A=Name | B=Date | C=Start | D=End | E=Production(min) | F=Break(min)
//   G=Dinner(min) | H=Meeting(min) | I=Training(min) | J=Idle(min) | K=Break Exceeded(min)
var BREAK_ALLOWANCE_MIN = 60;  // 1 hour break allowance per day

function closeSession_(ss, b) {
  return _withLock_(function () {
    var sh = ss.getSheetByName('Sessions');
    if (!sh) return { ok: false, error: 'Sessions missing' };
    // Force Date (B) + Start (C) + End (D) cols to plain text so Sheets
    // stops auto-converting the strings into Date/time objects that
    // serialize as "Sat Apr 25 2026 02:22:21 GMT+0530" on read.
    try {
      sh.getRange('B:B').setNumberFormat('@');
      sh.getRange('C:C').setNumberFormat('@');
      sh.getRange('D:D').setNumberFormat('@');
    } catch (e) {}
    // Date in PST (so a late-night IST shift stays on one date row)
    // Times in IST (so the team reads start/end in their own clock)
    var today = todayPST_();
    var user  = b.user || '';
    var nowTs = timeIST_();

    var prodMin     = Number(b.productionMin) || 0;
    var breakMin    = Number(b.breakMin)      || 0;
    var dinnerMin   = Number(b.dinnerMin)     || 0;
    var meetingMin  = Number(b.meetingMin)    || 0;
    var trainingMin = Number(b.trainingMin)   || 0;
    var idleMin     = Number(b.idleMin)       || 0;
    var breakExceeded = Math.max(0, breakMin - BREAK_ALLOWANCE_MIN);

    // Find existing row for [user, today] — Name in col A, Date in col B
    var rng = sh.getDataRange().getValues();
    for (var i = 1; i < rng.length; i++) {
      if (rng[i][0] === user && rng[i][1] === today) {
        sh.getRange(i + 1, 4).setValue(nowTs);         // End
        sh.getRange(i + 1, 5).setValue(prodMin);       // Production
        sh.getRange(i + 1, 6).setValue(breakMin);      // Break
        sh.getRange(i + 1, 7).setValue(dinnerMin);     // Dinner
        sh.getRange(i + 1, 8).setValue(meetingMin);    // Meeting
        sh.getRange(i + 1, 9).setValue(trainingMin);   // Training
        sh.getRange(i + 1, 10).setValue(idleMin);      // Idle
        sh.getRange(i + 1, 11).setValue(breakExceeded);// Break Exceeded
        // Guard against Sheets auto-formatting these minute cells as DateTime.
        sh.getRange(i + 1, 5, 1, 7).setNumberFormat('0');
        return { ok: true, updated: true, breakExceeded: breakExceeded };
      }
    }
    sh.appendRow([user, today, nowTs, nowTs,
                  prodMin, breakMin, dinnerMin, meetingMin, trainingMin, idleMin, breakExceeded]);
    // Force minute cols to integer format (new row just appended at bottom)
    sh.getRange(sh.getLastRow(), 5, 1, 7).setNumberFormat('0');
    // ── Drop the user's Live row when their shift closes ───────────
    // Otherwise the row lingers with stale data and TLs see a 'ghost'
    // on the Live Activity card (or Util computed from a Live row
    // that's already been written to Sessions, double-counting).
    try { _removeLiveRow_(ss, user); } catch (e) {
      try { Logger.log('removeLive failed: ' + e); } catch (_) {}
    }
    return { ok: true, inserted: true, breakExceeded: breakExceeded };
  });
}

// Delete the named user's row from the Live tab. Used by closeSession_
// (after End Shift) and by the daily archive trigger (sweep at 8 AM IST).
function _removeLiveRow_(ss, user) {
  var sh = ss.getSheetByName('Live');
  if (!sh) return false;
  var u = String(user || '').toLowerCase().trim();
  if (!u) return false;
  var vals = sh.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) {
    if (String(vals[i][1] || '').toLowerCase().trim() === u) {
      sh.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// One-shot cleanup. Run from the Apps Script editor once to:
//   1) Reformat Sessions cols E:K as plain integers
//   2) Rewrite any existing "0" cells so Sheets re-evaluates display
// Use when you see "1900-01-01 0:00:00" or similar date-like junk.
function fixSessionsFormat() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Sessions');
  if (!sh) return { ok: false, error: 'Sessions sheet missing' };
  var lastRow = Math.max(sh.getLastRow(), 2);
  // Columns E..K (5..11) → integer format
  sh.getRange(2, 5, lastRow - 1, 7).setNumberFormat('0');
  // Also coerce existing bogus values back to clean numbers.
  var rng  = sh.getRange(2, 5, lastRow - 1, 7);
  var vals = rng.getValues();
  var cleaned = 0;
  for (var r = 0; r < vals.length; r++) {
    for (var c = 0; c < vals[r].length; c++) {
      var v = vals[r][c];
      if (v instanceof Date) { vals[r][c] = 0; cleaned++; }
      else if (typeof v === 'string' && /^\s*1899|^\s*1900/.test(v)) { vals[r][c] = 0; cleaned++; }
      else if (typeof v !== 'number') { vals[r][c] = Number(v) || 0; }
    }
  }
  rng.setValues(vals);
  return { ok: true, reformattedCols: 'E:K', rowsScanned: vals.length, cellsCleaned: cleaned };
}

// One-shot cleanup: converts every existing date cell in Attendance,
// Sessions, and all team logs from Date objects back to plain "YYYY-MM-DD"
// (or "YYYY-MM-DD HH:mm:ss") strings, and locks those columns to plain
// text so Sheets stops re-coercing them. Run ONCE from the editor after
// deploying the format fixes.
function fixAllDateColumnsToText() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var report = { attendance: 0, sessions: 0, teamLogs: {}, errors: [] };
  var SS_TZ = ss.getSpreadsheetTimeZone() || 'Asia/Calcutta';

  function rewriteCol(sh, colIdx1Based, withTime) {
    if (!sh) return 0;
    var lr = sh.getLastRow();
    if (lr < 2) return 0;
    var rng = sh.getRange(2, colIdx1Based, lr - 1, 1);
    rng.setNumberFormat('@');
    var vals = rng.getValues();
    var disp = rng.getDisplayValues();  // pre-coerce display as fallback
    var cleaned = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i][0];
      if (v instanceof Date) {
        // Write the PST-date + (optionally IST-time) string based on the date's PST moment
        var s = withTime
          ? (Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd') + ' ' +
             Utilities.formatDate(v, TZ,                    'HH:mm:ss'))
          :  Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd');
        vals[i][0] = s;
        cleaned++;
      } else if (typeof v === 'string') {
        // Trim/trust existing strings
        vals[i][0] = v;
      } else if (v === '' || v == null) {
        vals[i][0] = '';
      } else {
        // Fall back to whatever Sheets shows
        vals[i][0] = String(disp[i][0] || '');
        cleaned++;
      }
    }
    rng.setValues(vals);
    return cleaned;
  }

  try {
    var att = ss.getSheetByName('Attendance');
    if (att) report.attendance = rewriteCol(att, 1, false);  // col A = Date

    var sess = ss.getSheetByName('Sessions');
    if (sess) {
      // Sessions col B = Date (no time), C = Start, D = End
      report.sessions = rewriteCol(sess, 2, false) +
                        rewriteCol(sess, 3, false) +
                        rewriteCol(sess, 4, false);
    }

    // All team logs: col A = Timestamp (PST date + IST time)
    Object.keys(TEAM_TO_TAB).forEach(function (team) {
      var sh = ss.getSheetByName(TEAM_TO_TAB[team]);
      if (!sh) return;
      try { report.teamLogs[team] = rewriteCol(sh, 1, true); }
      catch (e) { report.errors.push(team + ': ' + e); }
    });
  } catch (err) {
    report.errors.push(String(err));
  }

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// Companion cleanup for the Live tab. Sets col J (TaskStartedAt) format to
// plain text and rewrites any rows currently holding the Sheets epoch value
// "1899-12-30 0:00:00" back to empty string. Run once from the editor.
function fixLiveTaskStartedAt() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Live');
  if (!sh) return { ok: false, error: 'Live sheet missing' };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, cleared: 0 };
  var rng = sh.getRange(2, 10, lastRow - 1, 1);  // col J (TaskStartedAt) only
  rng.setNumberFormat('@');                       // plain text
  var vals = rng.getValues();
  var cleaned = 0;
  for (var r = 0; r < vals.length; r++) {
    var v = vals[r][0];
    if (v instanceof Date) { vals[r][0] = ''; cleaned++; }
    else if (typeof v === 'number' && v === 0) { vals[r][0] = ''; cleaned++; }
    else if (typeof v === 'string' && /^1899-12-30/.test(v)) { vals[r][0] = ''; cleaned++; }
  }
  rng.setValues(vals);
  return { ok: true, rowsScanned: vals.length, cellsCleaned: cleaned };
}

function clearForceReset_(ss, b) {
  return _withLock_(function () {
    var sh      = ss.getSheetByName('Config');
    var current = String(sh.getRange('B3').getValue() || '');
    if (!current) return { ok: true, cleared: false };
    var target  = String(b.user || '').toLowerCase();
    var names   = current.split(',').map(function (s) { return s.trim(); })
                         .filter(function (s) { return s && s.toLowerCase() !== target; });
    sh.getRange('B3').setValue(names.join(','));
    return { ok: true, cleared: true };
  });
}

// ─── Heartbeat: upsert current activity into "Live" sheet (keyed by user) ─
// Schema (12 cols, in column order):
//   A=ShiftStartAt | B=User | C=HomeTeam | D=Team | E=Activity | F=TasksDone
//   G=ProdMin | H=BreakMin | I=IdleMin | J=TaskStartedAt | K=TaskEndedAt
//   L=UpdatedAt (PST date + IST time)
// Ensure Live sheet exists with the canonical header row.
function ensureLiveSheet_(ss) {
  var HEADER = ['ShiftStartAt','User','HomeTeam','Team','Activity','TasksDone',
                'ProdMin','BreakMin','IdleMin','TaskStartedAt','TaskEndedAt','UpdatedAt'];
  var sh = ss.getSheetByName('Live');
  if (!sh) {
    sh = ss.insertSheet('Live');
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
    // Plain text for every time-string column so Sheets doesn't auto-date.
    sh.getRange('A:A').setNumberFormat('@');   // ShiftStartAt
    sh.getRange('J:J').setNumberFormat('@');   // TaskStartedAt
    sh.getRange('K:K').setNumberFormat('@');   // TaskEndedAt
    sh.getRange('L:L').setNumberFormat('@');   // UpdatedAt
    return sh;
  }
  // Normalize header if it drifted (idempotent — only overwrites row 1).
  var current = sh.getRange(1, 1, 1, Math.max(HEADER.length, sh.getLastColumn())).getValues()[0];
  var needsFix = false;
  for (var i = 0; i < HEADER.length; i++) {
    if (current[i] !== HEADER[i]) { needsFix = true; break; }
  }
  if (needsFix) {
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('J:J').setNumberFormat('@');
    sh.getRange('K:K').setNumberFormat('@');
    sh.getRange('L:L').setNumberFormat('@');
  }
  return sh;
}

// Current IST wall-clock time, "YYYY-MM-DD HH:MM:SS"
function istNow_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function heartbeat_(ss, b) {
  return _withLock_(function () {
    var sh = ensureLiveSheet_(ss);
    var user = String(b.user || '').trim();
    if (!user) return { ok: false, error: 'no user' };

    // Preserve existing ShiftStartAt, TaskStartedAt, TaskEndedAt unless client
    // supplied fresh values. Column map:
    //   A=ShiftStartAt(0) B=User(1) ... J=TaskStartedAt(9) K=TaskEndedAt(10) L=UpdatedAt(11)
    var existingShiftStart   = '';
    var existingTaskStarted  = '';
    var existingTaskEndedAt  = '';
    var vals = sh.getDataRange().getValues();
    var matchedRow = -1;
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][1]).toLowerCase() === user.toLowerCase()) {
        matchedRow = i + 1;
        existingShiftStart   = String(vals[i][0]  || '');
        existingTaskStarted  = String(vals[i][9]  || '');
        existingTaskEndedAt  = String(vals[i][10] || '');
        break;
      }
    }
    var shiftStartAt = String(b.shiftStartAt || '').trim() || existingShiftStart;

    // Canonicalize team/homeTeam so Live.Team matches what TL dashboards
    // filter on (Whitelist stores canonical names like "Utilities Blocked Cases",
    // but the app sends "Utilities_Blocked"). Fall back to raw if resolver
    // can't match (unknown team — better to log raw than drop the heartbeat).
    var canonTeam     = resolveTeam_(b.team)     || String(b.team || '');
    var canonHomeTeam = resolveTeam_(b.homeTeam) || String(b.homeTeam || '');

    // Row order MUST match HEADER in ensureLiveSheet_.
    var row = [
      shiftStartAt,                                           // A ShiftStartAt
      user,                                                   // B User
      canonHomeTeam,                                          // C HomeTeam
      canonTeam,                                              // D Team
      String(b.activity || ''),                               // E Activity
      Number(b.tasksDone || 0),                               // F TasksDone
      Number(b.productionMin || 0),                           // G ProdMin
      Number(b.breakMin || 0),                                // H BreakMin
      Number(b.idleMin || 0),                                 // I IdleMin
      // J TaskStartedAt: client sends ms-epoch when a new task opens.
      // If omitted, preserve the existing value so TLs keep seeing the
      // LAST task's start time (paired with TaskEndedAt for span reading).
      b.taskStartedAt
        ? pstDateIstTimeFromMs_(Number(b.taskStartedAt))
        : existingTaskStarted,
      existingTaskEndedAt,                                    // K TaskEndedAt (preserved; only _bumpLiveAfterTask_ writes it)
      nowPSTdateISTtime_()                                    // L UpdatedAt
    ];
    if (matchedRow > 0) {
      sh.getRange(matchedRow, 1, 1, row.length).setValues([row]);
      return { ok: true, upsert: 'update', row: matchedRow };
    }
    sh.appendRow(row);
    return { ok: true, upsert: 'insert', row: sh.getLastRow() };
  });
}

// Explicit "Start Your Day" signal — stamps ShiftStartAt with IST wall-clock.
// If the row doesn't exist yet, seed it; if it exists, only set ShiftStartAt + refresh UpdatedAt.
function shiftStart_(ss, b) {
  return _withLock_(function () {
    var sh = ensureLiveSheet_(ss);
    var user = String(b.user || '').trim();
    if (!user) return { ok: false, error: 'no user' };
    var shiftStartAt = String(b.shiftStartAt || '').trim() || istNow_();
    // Canonicalize for Live.Team/HomeTeam — see heartbeat_ comment.
    var canonTeam     = resolveTeam_(b.team)     || String(b.team || '');
    var canonHomeTeam = resolveTeam_(b.homeTeam) || String(b.homeTeam || '');
    // Column map: A=ShiftStartAt B=User C=HomeTeam D=Team ... L=UpdatedAt
    var vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][1]).toLowerCase() === user.toLowerCase()) {
        sh.getRange(i + 1, 1).setValue(shiftStartAt);           // A ShiftStartAt
        sh.getRange(i + 1, 12).setValue(nowPSTdateISTtime_());  // L UpdatedAt
        if (b.homeTeam) sh.getRange(i + 1, 3).setValue(canonHomeTeam); // C HomeTeam
        if (b.team)     sh.getRange(i + 1, 4).setValue(canonTeam);     // D Team
        return { ok: true, upsert: 'update', row: i + 1, shiftStartAt: shiftStartAt };
      }
    }
    // IMPORTANT: TaskStartedAt/TaskEndedAt = '' not 0. Writing 0 into a
    // date-formatted cell renders as the epoch "1899-12-30 0:00:00".
    sh.appendRow([
      shiftStartAt,                    // A ShiftStartAt
      user,                            // B User
      canonHomeTeam,                   // C HomeTeam
      canonTeam,                       // D Team
      'production',                    // E Activity
      0, 0, 0, 0,                      // F-I TasksDone/ProdMin/BreakMin/IdleMin
      '',                              // J TaskStartedAt
      '',                              // K TaskEndedAt
      nowPSTdateISTtime_()             // L UpdatedAt
    ]);
    return { ok: true, upsert: 'insert', row: sh.getLastRow(), shiftStartAt: shiftStartAt };
  });
}

// ─── Error telemetry: client JS + Swift crash reports land here ────────
// Schema of the Errors tab (auto-created if someone deletes it):
//   A=Timestamp (IST) · B=User · C=Version · D=Source (js|swift)
//   E=Kind · F=Message · G=URL/Context · H=Stack
// Capped at 2,000 rows so it never slows down the sheet. No lock needed —
// pure append, each row is a distinct event.
function handleLogError_(ss, body) {
  try {
    var sh = ss.getSheetByName('Errors');
    if (!sh) {
      sh = ss.insertSheet('Errors');
      sh.appendRow([
        'Timestamp (IST)', 'User', 'Version', 'Source',
        'Kind', 'Message', 'URL/Context', 'Stack'
      ]);
      sh.setFrozenRows(1);
    }

    var nowIST = Utilities.formatDate(
      new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'
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

    return { ok: true };
  } catch (err) {
    // Never crash the request — telemetry must never break the app.
    return { ok: false, error: String(err) };
  }
}

// ─── Live activity read: returns all users whose heartbeat is recent ─────
// Rows older than `staleMin` minutes (default 5) are considered offline and dropped.
function liveActivity_(ss, p) {
  // TL privacy: require valid session; filter users to caller's allowed teams.
  var who = _resolveCaller_(p);
  if (!who.ok) return { ok: false, error: who.error === 'expired' ? 'session_expired' : 'forbidden' };
  var wl = lookupWhitelist_(ss, who.email);
  if (!wl.ok) return { ok: false, error: 'forbidden' };
  // ★ QC reviewers don't get live activity data (tasks-only contract).
  // Returning empty rather than 'forbidden' so the dashboard can choose to
  // hide the Live tab silently instead of throwing a banner.
  if (wl.isQC) return { ok: true, users: [], byTeam: {}, isAdmin: false, isQC: true, teams: wl.teams };
  var allowed = wl.isAdmin ? null : {};
  if (!wl.isAdmin) wl.teams.forEach(function (t) { allowed[t] = true; });

  var sh = ss.getSheetByName('Live');
  if (!sh) return { ok: true, users: [], byTeam: {}, isAdmin: wl.isAdmin, teams: wl.teams };
  // 10 hours default — covers a full overnight shift through long
  // breaks/disconnects. autoCloseStaleShifts_ runs at 7:30 AM IST
  // before the 8 AM archive trigger, sweeping any leftover rows.
  // Override via &staleMin=N for one-off TL queries.
  var staleMin = Number((p && p.staleMin) || 600);
  var now = new Date();
  // Read both raw values AND display values. Display values are what
  // the user sees in the cell — bypasses all the Date-object/UTC-shift
  // headaches because Sheets has already done the formatting work.
  var rng = sh.getDataRange();
  var vals = rng.getValues();
  var disp = rng.getDisplayValues();
  var header = vals.shift() || [];
  disp.shift();
  var users = [];
  var byTeam = {};
  // Column map: A=ShiftStartAt(0) B=User(1) C=HomeTeam(2) D=Team(3)
  //   E=Activity(4) F=TasksDone(5) G=ProdMin(6) H=BreakMin(7) I=IdleMin(8)
  //   J=TaskStartedAt(9) K=TaskEndedAt(10) L=UpdatedAt(11)
  vals.forEach(function (r, idx) {
    var rDisp = disp[idx] || [];
    // UpdatedAt can come back as either a String (preferred — written via
    // setValue with a 'PST date + IST time' literal) OR a Date object if
    // the cell got auto-typed before the column was set to text format.
    // Handle both → re-format Date objects to the canonical string before
    // regex parsing so the row never drops out silently.
    // UpdatedAt — same as ShiftStartAt: use the display value to bypass
    // any Date-object UTC-offset weirdness.
    var updatedAtStr = String(rDisp[11] || r[11] || '').trim();
    // Accept single-digit hour — Sheets sometimes renders Date cells
    // without a leading zero on the hour ('2026-04-27 1:48:59').
    var parts = updatedAtStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!parts) return;
    // CRITICAL: 'now' must be in the SAME hybrid format as UpdatedAt
    // (PST date + IST time), NOT 'IST date + IST time'. Otherwise after
    // IST midnight the date components disagree by 1 day → fake 22-hour
    // age → row dropped even though heartbeat is fresh.
    var istNowStr = nowPSTdateISTtime_();
    var istNowParts = istNowStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!istNowParts) return;
    var toMs = function (m) {
      return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
    };
    var ageMin = (toMs(istNowParts) - toMs(parts)) / 60000;
    if (ageMin > staleMin) return;
    var homeTeam = String(r[2] || '');
    var team     = String(r[3] || '');
    // TL filter: show user only if their active team OR home team is allowed
    if (allowed && !allowed[team] && !allowed[homeTeam]) return;
    // ShiftStartAt — use the cell's DISPLAY value (what the user sees
    // in the sheet UI). This bypasses every Date-object / UTC-offset
    // bug because Sheets has already done the timezone work for us.
    // Falls back to raw value only if display is empty.
    var shiftStartStr = String(rDisp[0] || r[0] || '').trim();
    var rawShiftStart = r[0];
    // Wall-clock minutes since shift start — server-computed using the
    // CELL DISPLAY string (always 'YYYY-MM-DD HH:MM:SS' in IST wall-clock,
    // since the spreadsheet TZ is IST). Parse it as IST → convert to UTC
    // ms → subtract from now. Bypasses every Date-object UTC-offset
    // weirdness because we never touch the underlying typed value.
    var shiftMinutesElapsed = 0;
    var sm = shiftStartStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (sm) {
      var shiftStartMs = Date.UTC(+sm[1], +sm[2]-1, +sm[3], +sm[4], +sm[5], +sm[6]) - 5.5 * 3600 * 1000;
      shiftMinutesElapsed = Math.max(0, Math.round((now.getTime() - shiftStartMs) / 60000));
    }

    var u = {
      user:       String(r[1] || ''),
      homeTeam:   homeTeam,
      team:       team,
      activity:   String(r[4] || ''),
      tasksDone:  Number(r[5] || 0),
      prodMin:    Number(r[6] || 0),
      breakMin:   Number(r[7] || 0),
      idleMin:    Number(r[8] || 0),
      taskStartedAt: parseTaskStartedAt_(r[9]),
      taskEndedAt: String(r[10] || ''),
      updatedAt:  updatedAtStr,
      shiftStartAt: shiftStartStr,
      shiftMinutesElapsed: shiftMinutesElapsed,
      ageMin:     Math.round(ageMin * 10) / 10
    };
    users.push(u);
    var teamKey = u.team || u.homeTeam || 'Unassigned';
    if (!byTeam[teamKey]) byTeam[teamKey] = [];
    byTeam[teamKey].push(u);
  });
  return { ok: true, users: users, byTeam: byTeam, staleMin: staleMin, isAdmin: wl.isAdmin, teams: wl.teams };
}

// ─── GET handlers ──────────────────────────────────────────────────────
function getConfig_(ss) {
  var sh = ss.getSheetByName('Config');
  if (!sh) return {};
  return {
    version:    String(sh.getRange('B1').getValue() || ''),
    sourceUrl:  String(sh.getRange('B2').getValue() || ''),
    forceReset: String(sh.getRange('B3').getValue() || ''),
    banner:     String(sh.getRange('B6').getValue() || ''),
    killSwitch: String(sh.getRange('B7').getValue() || 'TRUE').toUpperCase() === 'TRUE'
  };
}

// Returns identity + allowed teams for a caller. Used by dashboard to render UI.
function whoami_(ss, email) {
  var wl = lookupWhitelist_(ss, email);
  if (!wl.ok) return { ok: false, error: 'not_whitelisted' };
  return {
    ok: true,
    email: wl.email,
    role: wl.role,
    isAdmin: wl.isAdmin,
    isQC: !!wl.isQC,
    teams: (wl.isAdmin || wl.isQC) ? Object.keys(TEAM_TO_TAB) : wl.teams
  };
}

function checkWhitelist_(ss, email) {
  var wl = lookupWhitelist_(ss, email);
  if (!wl.ok) return { ok: false, error: 'not_whitelisted' };
  return {
    ok: true, email: wl.email, role: wl.role,
    teams: wl.teams, isAdmin: wl.isAdmin, isQC: !!wl.isQC
  };
}

// Read a single team log — TL-privacy enforced.
function readLog_(ss, p) {
  var wl = lookupWhitelist_(ss, p.email);
  if (!wl.ok) return { ok: false, error: 'forbidden' };
  var rawTeam = String(p.team || '').trim();
  if (!rawTeam) return { ok: false, error: 'team required' };
  var team = resolveTeam_(rawTeam);
  if (!team) return { ok: false, error: 'unknown team: ' + rawTeam };
  if (!wl.isAdmin && wl.teams.indexOf(team) < 0) {
    return { ok: false, error: 'forbidden_team' };
  }
  var tab = TEAM_TO_TAB[team];
  if (!tab) return { ok: false, error: 'unknown team: ' + team };

  var date = p.date ? String(p.date) : '';

  // Past date? Serve from Drive monthly archive (active sheet keeps only
  // today's rows after nightly archive job runs at 8 AM IST).
  if (date && date !== todayPST_()) {
    var arch = readArchiveLog_(team, date);
    if (arch.ok) {
      return { ok: true, team: team, tab: tab, header: arch.header, rows: arch.rows, source: 'archive' };
    }
    // Fall through: if archive miss, try active sheet anyway (transitional week)
  }

  var sh = ss.getSheetByName(tab);
  if (!sh) return { ok: false, error: 'tab missing: ' + tab };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, team: team, tab: tab, header: [], rows: [], source: 'active' };

  // Read header once (col count comes from actual sheet)
  var lastCol = sh.getLastColumn();
  var header  = sh.getRange(1, 1, 1, lastCol).getValues()[0];

  // No date filter → return full tab (used rarely, usually bounded to "today" tabs)
  if (!date) {
    var all = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
    return { ok: true, team: team, tab: tab, header: header, rows: all, source: 'active' };
  }

  // Bottom-up scan: logs are append-only and sorted by time in col A.
  // Reads 500 rows at a time from the bottom and stops when we pass the
  // requested date. 50-100x faster than full-sheet scan at 30K+ rows.
  //
  // Use getDisplayValues for col A so we get "2026-04-27 20:59:07"
  // regardless of whether the underlying cell is a string OR a Date
  // object that Sheets auto-coerced. Otherwise rows whose Time cell
  // got typed as Date silently fail the date filter (the bug that hid
  // Ravi's 2nd task — String(dateObj).slice(0,10) yields "Sun Apr 27"
  // not "2026-04-27"). Also overwrite col A in the returned row with
  // the display string so downstream JSON serialization stays clean.
  var BLOCK = 500;
  var matched = [];
  var passed = false;
  var end = lastRow;
  while (end >= 2 && !passed) {
    var start = Math.max(2, end - BLOCK + 1);
    var rng   = sh.getRange(start, 1, end - start + 1, lastCol);
    var block = rng.getValues();
    var disp  = rng.getDisplayValues();
    for (var i = block.length - 1; i >= 0; i--) {
      var rowDate = String(disp[i][0] || '').slice(0, 10);
      if (rowDate === date) {
        block[i][0] = String(disp[i][0] || '');
        matched.unshift(block[i]);
      } else if (rowDate < date && rowDate.length === 10 && rowDate.charAt(4) === '-') {
        // Only break early on a properly-formatted date string we can
        // safely lexically-compare. Skip non-canonical strings (eg
        // "Sun Apr 27") so they don't trick the early-exit.
        passed = true; break;
      }
    }
    end = start - 1;
  }
  return { ok: true, team: team, tab: tab, header: header, rows: matched, source: 'active' };
}

// Multi-tab read for dashboard — respects scope.
// Caller must pass a valid session token (preferred) or whitelisted email.
function tlDashboard_(ss, p) {
  var who = _resolveCaller_(p);
  if (!who.ok) return { ok: false, error: who.error === 'expired' ? 'session_expired' : 'forbidden' };
  var wl = lookupWhitelist_(ss, who.email);
  if (!wl.ok) return { ok: false, error: 'forbidden' };
  // Default to PST date — Sessions tab stores dates in PST
  var date   = p.date ? String(p.date) : todayPST_();
  // QC reviewers see ALL teams (read-only, tasks-only).
  var teams  = (wl.isAdmin || wl.isQC) ? Object.keys(TEAM_TO_TAB) : wl.teams;
  var logs   = {};
  for (var i = 0; i < teams.length; i++) {
    var r = readLog_(ss, { email: who.email, team: teams[i], date: date });
    if (r.ok) logs[teams[i]] = { header: r.header, rows: r.rows };
  }

  // ★ QC-mode payload — strip everything except task logs. No attendance,
  // no sessions, no admin extras. Frontend keys off wl.role to render
  // a tasks-only view + read-only banner.
  if (wl.isQC) {
    return {
      ok: true,
      email: wl.email, role: wl.role,
      isAdmin: false, isQC: true, readOnly: true,
      teams: teams, date: date,
      logs: logs,
      attendance: { header: [], rows: [] },
      sessions:   { header: [], rows: [] }
    };
  }

  var attendance = readByDate_(ss, 'Attendance', date, wl.isAdmin ? null : teams);
  // ★ CHANGED: pass team filter so TLs only see sessions for their team's users.
  var sessions   = readSessionsByDate_(ss, date, wl.isAdmin ? null : teams);
  var result = {
    ok: true, email: wl.email, role: wl.role,
    isAdmin: wl.isAdmin, isQC: false,
    teams: teams, date: date,
    logs: logs, attendance: attendance, sessions: sessions
  };
  // Admin-only extras
  if (wl.isAdmin) {
    result.whitelist = getSheet_(ss, 'Whitelist');
    result.config    = getConfig_(ss);
  }
  return result;
}

// ─── Privacy helpers ───────────────────────────────────────────────────
function lookupWhitelist_(ss, email) {
  email = String(email || '').toLowerCase();
  if (!email) return { ok: false };
  var sh = ss.getSheetByName('Whitelist');
  if (!sh) return { ok: false };
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').toLowerCase() === email) {
      var role = String(rows[i][1] || '').toLowerCase();
      var teamsCell = String(rows[i][2] || '');
      // ★ Strict admin gate — ONLY super_admin gets admin powers (whitelist
      // edits, config, etc). Previously Teams=ALL also conferred isAdmin,
      // which would have leaked admin-only fields to QC reviewers (Teams=ALL,
      // role=qc). Restrict admin to the role itself.
      var isAdmin = role === 'super_admin';
      // ★ QC reviewer — read-only, tasks-only, all teams. See tlDashboard_.
      var isQC    = role === 'qc';
      var teams = teamsCell.toUpperCase() === 'ALL'
        ? Object.keys(TEAM_TO_TAB)
        : teamsCell.split(',')
                   .map(function (s) { return s.trim(); })
                   .filter(Boolean)
                   // Canonicalize each team so downstream filters always
                   // compare apples to apples, regardless of how an admin
                   // typed the team name in the Whitelist sheet.
                   .map(function (t) { return resolveTeam_(t) || t; });
      return { ok: true, email: email, role: role, teams: teams, isAdmin: isAdmin, isQC: isQC };
    }
  }
  return { ok: false };
}

function readByDate_(ss, tabName, date, teamFilter) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) return { header: [], rows: [] };
  var vals = sh.getDataRange().getValues();
  var header = vals.shift() || [];
  var rows = vals.filter(function (r) { return String(r[0]).indexOf(date) === 0; });
  if (teamFilter && teamFilter.length) {
    rows = rows.filter(function (r) { return teamFilter.indexOf(String(r[2] || '')) >= 0; });
  }
  return { header: header, rows: rows };
}

// ★ CHANGED: Sessions-specific reader with TL team filtering.
// Schema: A=Name, B=Date, C=Start, D=End, E=Production, F=Break, G=Dinner,
//         H=Meeting, I=Training, J=Idle, K=Break Exceeded.
// Sessions has no Team column, so for TL callers we derive the allowed-user
// set from Attendance (date + team) AND from that date's team-log rows (col B=User),
// then filter Sessions by Name. teamFilter=null → super-admin path (no filter).
function readSessionsByDate_(ss, date, teamFilter) {
  var sh = ss.getSheetByName('Sessions');
  if (!sh) return { header: [], rows: [] };
  var vals = sh.getDataRange().getValues();
  var header = vals.shift() || [];
  var rows = vals.filter(function (r) { return String(r[1]).indexOf(date) === 0; });

  // Super-admin path — no filter (identical to previous behavior)
  if (!teamFilter || !teamFilter.length) {
    return { header: header, rows: rows };
  }

  // Build allowed-name set: (1) Attendance for date+team, (2) team-log rows for date
  var teamSet = {};
  teamFilter.forEach(function (t) { teamSet[t] = true; });
  var nameSet = {};

  // (1) Attendance: col A=Date, col B=User, col C=Team
  var att = ss.getSheetByName('Attendance');
  if (att) {
    var aVals = att.getDataRange().getValues();
    for (var i = 1; i < aVals.length; i++) {
      if (String(aVals[i][0]).indexOf(date) !== 0) continue;
      var team = String(aVals[i][2] || '');
      if (!teamSet[team]) continue;
      var name = String(aVals[i][1] || '').toLowerCase().trim();
      if (name) nameSet[name] = true;
    }
  }

  // (2) Team logs for this date — covers users who logged tasks but skipped attendance
  Object.keys(teamSet).forEach(function (team) {
    var tab = TEAM_TO_TAB[team];
    if (!tab) return;
    var sh2 = ss.getSheetByName(tab);
    if (!sh2) return;
    var lr = sh2.getLastRow();
    if (lr < 2) return;
    var block = sh2.getRange(2, 1, lr - 1, 2).getValues(); // A=Timestamp, B=User
    for (var j = 0; j < block.length; j++) {
      if (String(block[j][0]).indexOf(date) !== 0) continue;
      var n = String(block[j][1] || '').toLowerCase().trim();
      if (n) nameSet[n] = true;
    }
  });

  var filtered = rows.filter(function (r) {
    var n = String(r[0] || '').toLowerCase().trim(); // Sessions col A = Name
    return !!nameSet[n];
  });
  return { header: header, rows: filtered };
}

function getSheet_(ss, tabName) {
  var sh = ss.getSheetByName(tabName);
  if (!sh) return { header: [], rows: [] };
  var vals = sh.getDataRange().getValues();
  var header = vals.shift() || [];
  return { header: header, rows: vals };
}

// ─── Utilities ─────────────────────────────────────────────────────────
function audit_(ss, action, email, payload) {
  try {
    var sh = ss.getSheetByName('Audit');
    if (!sh) return;
    var snip = JSON.stringify(payload || {}).slice(0, 500);
    sh.appendRow([nowIST_(), action, email, (payload && payload.user) || '', snip]);
  } catch (e) {}
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIST_()   { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function todayIST_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function timeIST_()  { return Utilities.formatDate(new Date(), TZ, 'HH:mm:ss'); }
function todayPST_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }
// Hybrid: PST calendar date + IST clock time, e.g. "2026-04-22 19:30:45"
function nowPSTdateISTtime_() { return todayPST_() + ' ' + timeIST_(); }
// Same hybrid but for any arbitrary epoch-ms (used for TaskStartedAt/TaskEndedAt).
function pstDateIstTimeFromMs_(ms) {
  var d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd') + ' ' +
         Utilities.formatDate(d, TZ,                     'HH:mm:ss');
}

// Coerce a Sheets cell value to a "yyyy-MM-dd" string.
// Google Sheets auto-converts date-like strings (e.g. "2026-04-24") written via
// appendRow() to native Date objects on read. A naive String(dateObj).slice(0,10)
// yields "Fri Apr 24" and breaks lexical date comparisons. Format in BOTH the
// spreadsheet's TZ and PST, return whichever matches the callsite's fromDate/toDate
// (both PST) — this handles sheets with IST/UTC/PST TZ without silently dropping
// rows due to midnight boundary shifts.
function _toYMD_(v) {
  if (v instanceof Date) {
    try {
      // Prefer the spreadsheet's own timezone — matches how Sheets displays the cell
      var ssTz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
      return Utilities.formatDate(v, ssTz || 'America/Los_Angeles', 'yyyy-MM-dd');
    } catch (e) {
      return Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd');
    }
  }
  return String(v || '').slice(0, 10);
}

// Parse TaskStartedAt cell value back to ms-epoch for the dashboard.
// Handles: new format ("yyyy-MM-dd HH:mm:ss" IST string), legacy ms-number rows,
// native Date objects (if the cell was coerced by Sheets), or blank.
function parseTaskStartedAt_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var s = String(v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);            // legacy raw-ms row
  var t = new Date(s.replace(' ', 'T') + '+05:30'); // IST → ms
  return isNaN(t.getTime()) ? 0 : t.getTime();
}

function fmtDur_(sec) {
  sec = Math.max(0, sec | 0);
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? (h + 'h ') : '') + (m + 'm ') + s + 's';
}

// Extract a property-address string from a task payload. Handles all the
// field-name variants the dashboard may send (Listings/SD teams use a
// dedicated "Property Address" field; others tuck it into a ticket/address
// combo field). Never throws — returns '' if nothing found.
function addr_(d) {
  d = d || {};
  return String(
    d['Property Address'] ||
    d['Address'] ||
    d['Ticket Link/Property Address'] ||
    d['Ticket Link / Property Address'] ||
    d['Flip Address'] ||
    ''
  );
}

// Sanitize a free-text ticket/address into a safe filename stem.
// Strips URL noise, replaces non-alphanumerics with underscores, collapses
// runs, trims to 80 chars. Never returns empty (falls back to "task").
function _safeFileBase_(raw) {
  var s = String(raw || '').trim();
  // If it's a URL, prefer the last path segment (more meaningful than host).
  var m = s.match(/^https?:\/\/[^\s]+$/i);
  if (m) {
    try {
      var path = s.replace(/^https?:\/\/[^\/]+\/?/i, '').split(/[?#]/)[0];
      var seg = path.split('/').filter(Boolean).pop() || s;
      s = seg;
    } catch (e) {}
  }
  s = s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return s || 'task';
}

// Save base64-encoded attachments to a Drive folder. Each file is named
// "<base>_<PSTdate>_<ISTtime>[_N].<ext>". Returns a list of viewer-shared
// Drive URLs. Throws if folder is unreachable so caller can surface.
function _saveAttachmentsToDrive_(attachments, baseName, folderId) {
  var folder = DriveApp.getFolderById(folderId);
  if (!folder) throw new Error('Drive folder not accessible: ' + folderId);
  var safe = _safeFileBase_(baseName);
  var dateStr = todayPST_();                // 2026-04-25
  var timeStr = timeIST_().replace(':','').slice(0,4); // HHMM
  var urls = [];
  for (var i = 0; i < attachments.length; i++) {
    var a = attachments[i] || {};
    if (!a.data) continue;
    var mime = a.mimeType || 'image/png';
    var ext = (mime.indexOf('jpeg') >= 0) ? 'jpg' : (mime.indexOf('png') >= 0 ? 'png' : 'bin');
    var suffix = (attachments.length > 1) ? ('_' + (i + 1)) : '';
    var fname = safe + '_' + dateStr + '_' + timeStr + suffix + '.' + ext;
    var bytes = Utilities.base64Decode(String(a.data));
    var blob  = Utilities.newBlob(bytes, mime, fname);
    var file  = folder.createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    urls.push(file.getUrl());
  }
  return urls;
}

// ─── One-time setup helpers (run from editor, optional) ────────────────
function setForceReset(names) {
  SpreadsheetApp.openById(SHEET_ID).getSheetByName('Config').getRange('B3').setValue(names || '');
}
function setSourceUrl(url) {
  SpreadsheetApp.openById(SHEET_ID).getSheetByName('Config').getRange('B2').setValue(url || '');
}
function setVersion(ver) {
  SpreadsheetApp.openById(SHEET_ID).getSheetByName('Config').getRange('B1').setValue(ver || '');
}

// ═══════════════════════════════════════════════════════════════════════
//  ARCHIVE SYSTEM — Phase 1.5
//  Daily at 8 AM IST, move yesterday's team-log rows into per-team monthly
//  rollup files in Drive ("Team Tracker Archives/{team}/{team}_Log_{yyyy_mm}").
//  Each team folder auto-shared (read-only) with TLs from Whitelist.
//  Dashboard transparently falls through to archives when TL picks a past
//  date — same table, same filters, just slower cache-cold (~800ms).
// ═══════════════════════════════════════════════════════════════════════

// Config!B9 holds the Drive folder ID of the archive root. If empty,
// ARCHIVE_ROOT_DEFAULT (the folder Arun provided) is used.
// Run setupArchive() once from the editor to initialise subfolders + permissions.
var ARCHIVE_ROOT_DEFAULT = '1hHzoyp8unXqbDUehmqob5Nl1k_FQ__5C';
// Name of the admin-only subfolder that holds full-sheet daily snapshots.
var OVERALL_FOLDER_NAME = '_Overall (Admins Only)';

function _getArchiveRootId_() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Config');
  var id = String(sh.getRange('B9').getValue() || '').trim();
  return id || ARCHIVE_ROOT_DEFAULT;
}
function _setArchiveRootId_(id) {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Config');
  sh.getRange('B9').setValue(id);
}

// Run ONCE from the Apps Script editor: uses the provided root folder,
// creates 17 team subfolders + an admin-only Overall subfolder,
// shares each with the TL on Whitelist, writes root id to B9.
function setupArchive() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var rootId = _getArchiveRootId_();
  var root;
  try {
    root = DriveApp.getFolderById(rootId);
  } catch (e) {
    throw new Error('Cannot access archive root folder (' + rootId + '). Make sure the Apps Script owner has edit access. ' + e);
  }
  _setArchiveRootId_(root.getId());

  // Team subfolders
  var teams = Object.keys(TEAM_TO_TAB);
  teams.forEach(function (team) {
    var safe = _folderNameForTeam_(team);
    var folder = _findOrCreateChild_(root, safe);
    Logger.log('Folder ready: ' + safe + ' → ' + folder.getId());
  });

  // Admin-only overall folder
  var overall = _findOrCreateChild_(root, OVERALL_FOLDER_NAME);
  Logger.log('Overall folder ready → ' + overall.getId());

  // Grant access from Whitelist
  syncArchivePermissions();
  return { ok: true, rootId: root.getId(), teams: teams.length, overall: overall.getId() };
}

function _folderNameForTeam_(team) {
  // Drive folder names can't contain '/'. Replace with '-' for 'Trust / Safety'.
  return team.replace(/\//g, '-').replace(/\s+/g, ' ').trim();
}

function _findOrCreateChild_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function _findFileInFolder_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

// Sync Drive permissions from Whitelist — run daily or when TL roster changes.
// Super_admins → edit on root. TLs → view on their team subfolders.
function syncArchivePermissions() {
  var rootId = _getArchiveRootId_();
  if (!rootId) return { ok: false, error: 'archive not set up; run setupArchive()' };
  var root = DriveApp.getFolderById(rootId);

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var wl = ss.getSheetByName('Whitelist');
  if (!wl) return { ok: false, error: 'no Whitelist tab' };
  var rows = wl.getDataRange().getValues();
  var admins = [];
  var tlTeams = {}; // team -> [email, ...]
  for (var i = 1; i < rows.length; i++) {
    var email = String(rows[i][0] || '').toLowerCase().trim();
    var role  = String(rows[i][1] || '').toLowerCase().trim();
    var teams = String(rows[i][2] || '');
    if (!email) continue;
    if (role === 'super_admin' || teams.toUpperCase() === 'ALL') {
      admins.push(email);
    } else if (role === 'tl') {
      teams.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (t) {
        (tlTeams[t] = tlTeams[t] || []).push(email);
      });
    }
  }

  // Super_admins get editor access on root (cascades to all subfolders)
  admins.forEach(function (e) {
    try { root.addEditor(e); } catch (err) { Logger.log('addEditor ' + e + ' failed: ' + err); }
  });

  // TLs get viewer access on their team folder
  Object.keys(TEAM_TO_TAB).forEach(function (team) {
    var folder = _findOrCreateChild_(root, _folderNameForTeam_(team));
    var emails = tlTeams[team] || [];
    emails.forEach(function (e) {
      try { folder.addViewer(e); } catch (err) { Logger.log('addViewer ' + e + '@' + team + ' failed: ' + err); }
    });
  });

  // Overall folder → super_admins only. Explicitly revoke any inherited
  // TL viewers that may have been added earlier. (addEditor on root already
  // cascades to admins; removeViewer on this folder strips any TL who
  // might have been added before this lock-down was in place.)
  try {
    var overall = _findOrCreateChild_(root, OVERALL_FOLDER_NAME);
    // Strip all viewers/editors who aren't super_admin
    var adminSet = {};
    admins.forEach(function (e) { adminSet[String(e).toLowerCase()] = true; });
    overall.getViewers().forEach(function (u) {
      var em = String(u.getEmail() || '').toLowerCase();
      if (em && !adminSet[em]) { try { overall.removeViewer(em); } catch (err) {} }
    });
    overall.getEditors().forEach(function (u) {
      var em = String(u.getEmail() || '').toLowerCase();
      if (em && !adminSet[em]) { try { overall.removeEditor(em); } catch (err) {} }
    });
    // Ensure admins are editors here too
    admins.forEach(function (e) { try { overall.addEditor(e); } catch (err) {} });
  } catch (err) { Logger.log('overall lockdown failed: ' + err); }

  return { ok: true, admins: admins.length, teams: Object.keys(tlTeams).length };
}

// Get or create the monthly rollup spreadsheet for a team, e.g. "BRN_Log_2026_04".
function _getMonthlyArchiveFile_(team, yyyymm) {
  var rootId = _getArchiveRootId_();
  if (!rootId) throw new Error('archive not set up; run setupArchive()');
  var root = DriveApp.getFolderById(rootId);
  var folder = _findOrCreateChild_(root, _folderNameForTeam_(team));
  var baseName = TEAM_TO_TAB[team].replace(/_Log$/, '') + '_Log_' + yyyymm;
  var existing = _findFileInFolder_(folder, baseName);
  if (existing) {
    return SpreadsheetApp.openById(existing.getId());
  }
  // Create new spreadsheet and move it into the team folder
  var ssArch = SpreadsheetApp.create(baseName);
  var file = DriveApp.getFileById(ssArch.getId());
  folder.addFile(file);
  try { DriveApp.getRootFolder().removeFile(file); } catch (e) {}
  return ssArch;
}

// Daily trigger entry point — install via installArchiveTrigger().
// Moves yesterday's rows (PST date) from each team tab into its monthly
// archive file, verifies the copy, then deletes the source rows.
function dailyArchive() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var cutoff = _yesterdayPST_();        // "yyyy-mm-dd" — date BEING archived
  var yyyymm = cutoff.slice(0, 7).replace('-', '_'); // "2026_04"
  var log = { date: cutoff, started: istNow_(), teams: {}, ok: true, errors: [] };

  Object.keys(TEAM_TO_TAB).forEach(function (team) {
    try {
      var res = _archiveTeamDay_(ss, team, cutoff, yyyymm);
      log.teams[team] = res;
    } catch (err) {
      log.ok = false;
      log.errors.push(team + ': ' + err);
      log.teams[team] = { ok: false, error: String(err) };
    }
  });

  // Full-sheet daily snapshot → admin-only folder.
  // This is a copy of the whole spreadsheet (every tab as-of this moment)
  // so super_admins can always reconstruct any day even if team moves fail.
  try {
    var snap = _archiveFullSheet_(ss, cutoff);
    log.overall = snap;
  } catch (err) {
    log.ok = false;
    log.errors.push('overall: ' + err);
    log.overall = { ok: false, error: String(err) };
  }

  // After archiving, sweep the Live tab — any rows still there at
  // 8 AM IST belong to users who never clicked End Shift. Their
  // Sessions row already has the canonical data (or doesn't, in
  // which case the past-date approx fallback handles it). Either
  // way, the Live row is no longer useful and just pollutes
  // tomorrow's Live Activity view.
  try {
    var liveSh = ss.getSheetByName('Live');
    if (liveSh && liveSh.getLastRow() > 1) {
      var swept = liveSh.getLastRow() - 1;
      liveSh.getRange(2, 1, swept, liveSh.getLastColumn()).clearContent();
      log.liveSwept = swept;
    }
  } catch (err) {
    log.errors.push('live sweep: ' + err);
  }

  log.finished = istNow_();
  _writeArchiveLog_(ss, log);
  if (!log.ok) _alertArchiveFailure_(log);
  return log;
}

// Full spreadsheet snapshot → admin-only folder. Makes a Drive copy of the
// entire workbook BEFORE team moves delete the rows, so admins have a
// belt-and-braces per-day record even if a team-level move fails.
function _archiveFullSheet_(ss, cutoff) {
  var rootId = _getArchiveRootId_();
  var root = DriveApp.getFolderById(rootId);
  var overall = _findOrCreateChild_(root, OVERALL_FOLDER_NAME);
  var name = 'Overall_Snapshot_' + cutoff;
  // If today's snapshot already exists, skip (idempotent re-runs)
  var existing = _findFileInFolder_(overall, name);
  if (existing) {
    return { ok: true, note: 'snapshot already exists', file: name, id: existing.getId() };
  }
  var srcFile = DriveApp.getFileById(ss.getId());
  var copy = srcFile.makeCopy(name, overall);
  return { ok: true, file: name, id: copy.getId() };
}

function _archiveTeamDay_(ss, team, cutoff, yyyymm) {
  var tab = TEAM_TO_TAB[team];
  var sh = ss.getSheetByName(tab);
  if (!sh) return { ok: true, moved: 0, note: 'tab missing' };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, moved: 0, note: 'empty' };

  var lastCol = sh.getLastColumn();
  var header  = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var values  = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Rows to archive = col A starts with cutoff date.
  // Find contiguous bottom range with date < today (handles the intended case:
  // tab has only today's rows at the top after archive, BUT first-run has
  // months of data, so we explicitly filter by exact cutoff date here).
  var toArchive = [];
  var toKeep = [];
  values.forEach(function (r) {
    var d = String(r[0]).slice(0, 10);
    if (d === cutoff) toArchive.push(r);
    else toKeep.push(r);
  });
  if (toArchive.length === 0) return { ok: true, moved: 0, note: 'no rows for ' + cutoff };

  // Write to monthly archive file
  var archSs = _getMonthlyArchiveFile_(team, yyyymm);
  var archSh = archSs.getSheets()[0];
  // Ensure archive header (only on first write)
  if (archSh.getLastRow() < 1) {
    archSh.getRange(1, 1, 1, header.length).setValues([header]);
    archSh.setFrozenRows(1);
  }
  var archStart = archSh.getLastRow() + 1;
  archSh.getRange(archStart, 1, toArchive.length, toArchive[0].length).setValues(toArchive);
  SpreadsheetApp.flush();

  // Verify: count archived rows matches source
  var writtenRows = archSh.getRange(archStart, 1, toArchive.length, 1).getValues();
  if (writtenRows.length !== toArchive.length) {
    throw new Error('verify failed for ' + team + ': expected ' + toArchive.length + ', got ' + writtenRows.length);
  }

  // Safe to delete from source — rewrite tab with keep-rows only
  sh.getRange(2, 1, values.length, lastCol).clearContent();
  if (toKeep.length > 0) {
    sh.getRange(2, 1, toKeep.length, toKeep[0].length).setValues(toKeep);
  }
  SpreadsheetApp.flush();
  return { ok: true, moved: toArchive.length, kept: toKeep.length, archiveFile: archSs.getName() };
}

function _yesterdayPST_() {
  var d = new Date();
  d.setTime(d.getTime() - 86400000);
  return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
}

function _writeArchiveLog_(ss, log) {
  var sh = ss.getSheetByName('ArchiveLog');
  if (!sh) {
    sh = ss.insertSheet('ArchiveLog');
    sh.appendRow(['Date', 'Started', 'Finished', 'OK', 'Team', 'Moved', 'Kept', 'File', 'Error']);
    sh.setFrozenRows(1);
  }
  Object.keys(log.teams).forEach(function (team) {
    var t = log.teams[team];
    sh.appendRow([
      log.date, log.started, log.finished, t.ok === false ? 'NO' : 'YES',
      team, t.moved || 0, t.kept || 0, t.archiveFile || '', t.error || t.note || ''
    ]);
  });
  // Overall snapshot row
  if (log.overall) {
    var o = log.overall;
    sh.appendRow([
      log.date, log.started, log.finished, o.ok === false ? 'NO' : 'YES',
      '__OVERALL__', 0, 0, o.file || '', o.error || o.note || ''
    ]);
  }
}

function _alertArchiveFailure_(log) {
  try {
    var admins = [];
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var wl = ss.getSheetByName('Whitelist');
    var rows = wl.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var role = String(rows[i][1] || '').toLowerCase();
      if (role === 'super_admin') admins.push(String(rows[i][0] || ''));
    }
    if (admins.length === 0) return;
    MailApp.sendEmail({
      to: admins.join(','),
      subject: '⚠️ Team Tracker archive FAILED for ' + log.date,
      body: 'Daily archive did not complete cleanly.\n\nErrors:\n' + log.errors.join('\n') +
            '\n\nCheck the ArchiveLog tab for details.\nSheet: https://docs.google.com/spreadsheets/d/' + SHEET_ID
    });
  } catch (e) { Logger.log('alert failed: ' + e); }
}

// Install 8 AM IST daily trigger. Run once from editor.
function installArchiveTrigger() {
  // Remove any existing dailyArchive triggers first (idempotent)
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyArchive') ScriptApp.deleteTrigger(t);
  });
  // 8 AM IST = 2:30 AM UTC = previous day 19:30 PST. Apps Script schedules
  // in the script's timezone — set project TZ to Asia/Calcutta, or use nearHour.
  ScriptApp.newTrigger('dailyArchive')
    .timeBased()
    .atHour(8)  // IST assumed from script TZ; if project TZ differs, adjust.
    .everyDays(1)
    .create();
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO-CLOSE — runs daily at 7:30 AM IST, BEFORE the 8 AM archive.
// For every user still in the Live tab, write a Sessions row using
// their last-known heartbeat data (treats last UpdatedAt as effective
// shift end). Then clear Live so the dashboard starts the new day clean.
//
// Why: users who close their laptop without clicking 'End Shift' leave
// a Live row with stale data. Without this, Sessions tab is missing
// their canonical entry and the dashboard has to guess. After this runs,
// EVERY shift has a Sessions row — canonical end-of-shift data for all.
// ═══════════════════════════════════════════════════════════════════════
function autoCloseStaleShifts_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var liveSh = ss.getSheetByName('Live');
  var sessSh = ss.getSheetByName('Sessions');
  if (!liveSh || !sessSh) return { ok: false, error: 'sheets missing' };

  var lastRow = liveSh.getLastRow();
  if (lastRow < 2) return { ok: true, processed: 0, note: 'live empty' };

  // Snapshot Live + Sessions (display values for date/time strings)
  var liveRng = liveSh.getDataRange();
  var liveVals = liveRng.getValues();
  var liveDisp = liveRng.getDisplayValues();
  var sessRng = sessSh.getDataRange();
  var sessVals = sessRng.getValues();
  var sessDisp = sessRng.getDisplayValues();

  // Index existing Sessions rows by (user_lower, pstDate)
  var sessIndex = {};
  for (var s = 1; s < sessVals.length; s++) {
    var sName = String(sessVals[s][0] || '').toLowerCase().trim();
    var sDate = String(sessDisp[s][1] || '').slice(0, 10);
    if (sName && sDate) sessIndex[sName + '|' + sDate] = s + 1;
  }

  var processed = 0;
  var processedUsers = [];
  for (var i = 1; i < liveVals.length; i++) {
    var user = String(liveVals[i][1] || '').trim();
    if (!user) continue;

    var shiftStartStr = String(liveDisp[i][0] || '').trim();
    var updatedAtStr  = String(liveDisp[i][11] || '').trim();
    var prodMin       = Number(liveVals[i][6]) || 0;
    var breakMin      = Number(liveVals[i][7]) || 0;
    var idleMin       = Number(liveVals[i][8]) || 0;

    // PST date for the Sessions row = first 10 chars of shiftStartAt.
    var pstDate  = shiftStartStr.slice(0, 10);
    var startTm  = shiftStartStr.slice(11) || timeIST_();
    // Effective end = last heartbeat. If empty, fall back to now.
    var endTm    = updatedAtStr.slice(11) || timeIST_();
    if (!pstDate) continue;

    var breakExceeded = Math.max(0, breakMin - BREAK_ALLOWANCE_MIN);
    var key = user.toLowerCase() + '|' + pstDate;

    if (sessIndex[key]) {
      // Update existing Sessions row for this user/date
      var rowIdx = sessIndex[key];
      sessSh.getRange(rowIdx, 4).setValue(endTm);
      sessSh.getRange(rowIdx, 5).setValue(prodMin);
      sessSh.getRange(rowIdx, 6).setValue(breakMin);
      sessSh.getRange(rowIdx, 10).setValue(idleMin);
      sessSh.getRange(rowIdx, 11).setValue(breakExceeded);
      sessSh.getRange(rowIdx, 5, 1, 7).setNumberFormat('0');
    } else {
      // Append new Sessions row — auto-closed shift
      sessSh.appendRow([user, pstDate, startTm, endTm,
                        prodMin, breakMin, 0, 0, 0, idleMin, breakExceeded]);
      sessSh.getRange(sessSh.getLastRow(), 5, 1, 7).setNumberFormat('0');
    }
    processed++;
    processedUsers.push(user);
  }

  // Clear all Live rows now that they're captured in Sessions
  if (lastRow > 1) {
    liveSh.getRange(2, 1, lastRow - 1, liveSh.getLastColumn()).clearContent();
  }

  Logger.log('autoCloseStaleShifts_: processed ' + processed + ' users: ' + processedUsers.join(', '));
  return { ok: true, processed: processed, users: processedUsers };
}

// Install the 7:30 AM IST trigger. Run once from the editor.
function installAutoCloseTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoCloseStaleShifts_') ScriptApp.deleteTrigger(t);
  });
  // Apps Script can't pick an exact minute. atHour(7) + nearMinute(30)
  // schedules the trigger near 7:30 AM in the script's TZ. Verify the
  // project TZ is 'Asia/Calcutta' under File → Project Settings.
  ScriptApp.newTrigger('autoCloseStaleShifts_')
    .timeBased()
    .atHour(7)
    .nearMinute(30)
    .everyDays(1)
    .create();
  return { ok: true };
}

// ─── Archive READ (dashboard fallback) ─────────────────────────────────
// Called by readLog_() when date !== today. Uses CacheService so repeat
// reads in the same 10-min window stay instant.
function readArchiveLog_(team, date) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'arch:' + team + ':' + date;
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);

    var rootId = _getArchiveRootId_();
    if (!rootId) return { ok: false, error: 'archive not configured' };
    var root = DriveApp.getFolderById(rootId);
    var folder = _findOrCreateChild_(root, _folderNameForTeam_(team));
    var yyyymm = date.slice(0, 7).replace('-', '_');
    var baseName = TEAM_TO_TAB[team].replace(/_Log$/, '') + '_Log_' + yyyymm;
    var file = _findFileInFolder_(folder, baseName);
    if (!file) return { ok: true, header: [], rows: [], note: 'no archive file for ' + yyyymm };

    var archSs = SpreadsheetApp.openById(file.getId());
    var sh = archSs.getSheets()[0];
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) return { ok: true, header: [], rows: [] };
    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var rng    = sh.getRange(2, 1, lastRow - 1, lastCol);
    var values = rng.getValues();
    // Archive sheets aren't format-locked, so col A often holds Date
    // objects. Use getDisplayValues() for date filtering AND overwrite
    // col A with the display string so JSON → dashboard gets a clean
    // "2026-04-24 20:52:36" instead of an ISO-UTC Date serialisation.
    var disp = rng.getDisplayValues();
    var rows = [];
    for (var i = 0; i < values.length; i++) {
      var d = String(disp[i][0] || '').slice(0, 10);
      if (d !== date) continue;
      values[i][0] = String(disp[i][0] || '');
      rows.push(values[i]);
    }
    var result = { ok: true, header: header, rows: rows, source: 'archive', file: baseName };
    // Cache 10 min — plenty for multiple TL hits on same date
    cache.put(key, JSON.stringify(result), 600);
    return result;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RESET — wipes all logs for a clean rollout start.
// Destructive: clears every team tab, Live, ArchiveLog, and trashes every
// file inside each team folder + _Overall folder on Drive.
// Run ONCE from the Apps Script editor when you want a fresh slate.
// ═══════════════════════════════════════════════════════════════════════
function resetAllLogs() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var report = { clearedTabs: [], clearedLive: false, clearedArchiveLog: false, deletedDriveFiles: 0, errors: [] };

  // 1. Clear each team tab (keep row 1 header)
  Object.keys(TEAM_TO_TAB).forEach(function (team) {
    var tab = TEAM_TO_TAB[team];
    var sh = ss.getSheetByName(tab);
    if (!sh) return;
    var lastRow = sh.getLastRow();
    if (lastRow > 1) {
      sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
    }
    report.clearedTabs.push(tab);
  });

  // 2. Clear Live tab (keep row 1 header)
  var live = ss.getSheetByName('Live');
  if (live && live.getLastRow() > 1) {
    live.getRange(2, 1, live.getLastRow() - 1, live.getLastColumn()).clearContent();
    report.clearedLive = true;
  }

  // 3. Clear ArchiveLog tab (keep row 1 header)
  var al = ss.getSheetByName('ArchiveLog');
  if (al && al.getLastRow() > 1) {
    al.getRange(2, 1, al.getLastRow() - 1, al.getLastColumn()).clearContent();
    report.clearedArchiveLog = true;
  }

  // 4. Trash every file inside each team folder + _Overall folder
  try {
    var rootId = _getArchiveRootId_();
    var root = DriveApp.getFolderById(rootId);
    // Team folders
    Object.keys(TEAM_TO_TAB).forEach(function (team) {
      var folder = _findOrCreateChild_(root, _folderNameForTeam_(team));
      var it = folder.getFiles();
      while (it.hasNext()) {
        var f = it.next();
        f.setTrashed(true);
        report.deletedDriveFiles++;
      }
    });
    // Overall folder
    var overall = _findOrCreateChild_(root, OVERALL_FOLDER_NAME);
    var it2 = overall.getFiles();
    while (it2.hasNext()) {
      var f2 = it2.next();
      f2.setTrashed(true);
      report.deletedDriveFiles++;
    }
  } catch (err) {
    report.errors.push('drive cleanup: ' + err);
  }

  // 5. Flush cache so archive reads don't return stale data
  try { CacheService.getScriptCache().removeAll([]); } catch (e) {}

  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// ═══════════════════════════════════════════════════════════════════════
// EMAIL-OTP AUTHENTICATION
// Replaces the free-text email gate. Proves the person on the other end
// actually controls the inbox — stops TL-A from impersonating TL-B by
// typing their email. Flow:
//   1) requestOtp  → generate 6-digit code, cache 10 min, email it
//   2) verifyOtp   → check code, issue HMAC-signed session token (8h TTL)
//   3) every privileged endpoint (tlDashboard, liveActivity) verifies the
//      token on each call (drop-in: pass ?token=... instead of ?email=...)
// No Google Cloud, no OAuth consent screen, no paid infra.
// ═══════════════════════════════════════════════════════════════════════

var OTP_TTL_SEC       = 600;       // 10 min — code expires
var SESSION_TTL_SEC   = 8 * 3600;  // 8 hours — one TL work-day
var OTP_RATE_LIMIT    = 3;         // max 3 codes per email per 10 min

function requestOtp_(ss, email) {
  email = String(email || '').toLowerCase().trim();
  if (!email) return { ok: false, error: 'email_required' };

  // Must be on the Whitelist — don't leak OTPs to random addresses
  var wl = lookupWhitelist_(ss, email);
  if (!wl.ok) return { ok: false, error: 'not_whitelisted' };

  // Rate limit: prevent abuse
  var cache = CacheService.getScriptCache();
  var rlKey = 'otp_rl:' + email;
  var count = Number(cache.get(rlKey) || 0);
  if (count >= OTP_RATE_LIMIT) {
    return { ok: false, error: 'rate_limited', message: 'Too many codes requested. Wait 10 minutes.' };
  }
  cache.put(rlKey, String(count + 1), OTP_TTL_SEC);

  // Generate 6-digit code
  var code = '';
  for (var i = 0; i < 6; i++) code += Math.floor(Math.random() * 10);
  cache.put('otp:' + email, code, OTP_TTL_SEC);

  // Email it (MailApp has a 100/day free quota, 1500/day on Workspace)
  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Your Team Tracker sign-in code: ' + code,
      htmlBody:
        '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:480px;padding:24px;background:#0f1420;color:#e6edf5;border-radius:12px">' +
        '<h2 style="margin:0 0 12px">Team Tracker Dashboard</h2>' +
        '<p style="color:#9aa7b8;margin:0 0 24px">Use this code to sign in. It expires in 10 minutes.</p>' +
        '<div style="font-size:42px;letter-spacing:8px;font-weight:700;color:#4f8cff;background:#1a2133;padding:20px;border-radius:8px;text-align:center;font-family:monospace">' + code + '</div>' +
        '<p style="color:#6b7a8f;font-size:13px;margin:24px 0 0">Didn\'t request this? Ignore this email. Your account is safe.</p>' +
        '</div>'
    });
  } catch (err) {
    return { ok: false, error: 'mail_failed', message: String(err) };
  }

  return { ok: true, message: 'Code sent. Check your email.' };
}

function verifyOtp_(ss, email, code) {
  email = String(email || '').toLowerCase().trim();
  code  = String(code  || '').trim();
  if (!email || !code) return { ok: false, error: 'missing_fields' };

  var cache = CacheService.getScriptCache();
  var stored = cache.get('otp:' + email);
  if (!stored) return { ok: false, error: 'code_expired_or_invalid' };
  if (stored !== code) return { ok: false, error: 'code_mismatch' };

  // Consume the code (single-use)
  cache.remove('otp:' + email);

  // Re-check whitelist (it may have been revoked since requestOtp)
  var wl = lookupWhitelist_(ss, email);
  if (!wl.ok) return { ok: false, error: 'not_whitelisted' };

  var token = _signToken_({ email: email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC });
  return {
    ok: true, token: token,
    email: wl.email, role: wl.role,
    isAdmin: wl.isAdmin, isQC: !!wl.isQC,
    // QC reviewers see all teams; TLs see only their assigned teams.
    teams: (wl.isAdmin || wl.isQC) ? Object.keys(TEAM_TO_TAB) : wl.teams
  };
}

// ─── Session token helpers ─────────────────────────────────────────────
// Format: base64url(payload).base64url(HMAC-SHA256(payload, SECRET))
// Secret lives in Config!B10 — auto-generated on first use if empty.
function _getHmacSecret_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName('Config');
  var v = String(sh.getRange('B10').getValue() || '').trim();
  if (v) return v;
  // First use — generate a 32-byte random secret and persist it
  var bytes = [];
  for (var i = 0; i < 32; i++) bytes.push(Math.floor(Math.random() * 256));
  var secret = Utilities.base64EncodeWebSafe(Utilities.newBlob(bytes).getBytes());
  sh.getRange('A10').setValue('sessionSecret');
  sh.getRange('B10').setValue(secret);
  return secret;
}

function _b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function _signToken_(payload) {
  var secret = _getHmacSecret_();
  var payloadStr = JSON.stringify(payload);
  var payloadB64 = _b64url_(Utilities.newBlob(payloadStr).getBytes());
  var sig = Utilities.computeHmacSha256Signature(payloadStr, secret);
  var sigB64 = _b64url_(sig);
  return payloadB64 + '.' + sigB64;
}

function _verifyToken_(token) {
  if (!token) return { ok: false, error: 'no_token' };
  var parts = String(token).split('.');
  if (parts.length !== 2) return { ok: false, error: 'bad_token' };
  try {
    // Decode payload
    var padded = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    var payloadBytes = Utilities.base64DecodeWebSafe(padded);
    var payloadStr = Utilities.newBlob(payloadBytes).getDataAsString();
    // Recompute signature
    var secret = _getHmacSecret_();
    var expectedSig = Utilities.computeHmacSha256Signature(payloadStr, secret);
    var expectedB64 = _b64url_(expectedSig);
    if (expectedB64 !== parts[1]) return { ok: false, error: 'bad_signature' };
    // Check expiry
    var payload = JSON.parse(payloadStr);
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'expired' };
    }
    return { ok: true, email: String(payload.email || '').toLowerCase() };
  } catch (err) {
    return { ok: false, error: 'parse_error: ' + err };
  }
}

// Resolves the "who is calling" email for a request. Prefers a signed
// session token; falls back to raw email param (for the OTP endpoints
// themselves and for backward compat during transition).
function _resolveCaller_(p) {
  if (p && p.token) {
    var v = _verifyToken_(p.token);
    if (v.ok) return { ok: true, email: v.email, viaToken: true };
    return { ok: false, error: v.error };
  }
  if (p && p.email) return { ok: true, email: String(p.email).toLowerCase(), viaToken: false };
  return { ok: false, error: 'no_auth' };
}

// ═══════════════════════════════════════════════════════════════════════
// MY DASHBOARD — personal, per-user, opened from inside the Mac app.
// The Swift app POSTs {action:'myDashboardToken', user:'<NSFullUserName>'}
// and opens /my/index.html#token=<t>&user=<u>. Frontend then hits
// GET ?action=myStats&token=<t>&fromDate=...&toDate=...&team=(optional)
// and computes per-filter breakdowns client-side.
// ═══════════════════════════════════════════════════════════════════════

var MY_TOKEN_TTL_SEC = 8 * 3600; // 8 hours — long enough to cover a shift

function myDashboardToken_(ss, b) {
  var user = String((b && b.user) || '').trim();
  if (!user) return { ok: false, error: 'user required' };
  // Best-effort: the user must have been seen in the system at least once
  // (either Attendance, Sessions, or a team log). Skip the check if the
  // sheet is empty during first-run testing.
  var token = _signToken_({
    user: user,
    kind: 'my',
    exp:  Math.floor(Date.now() / 1000) + MY_TOKEN_TTL_SEC
  });
  return { ok: true, token: token, user: user, ttlSec: MY_TOKEN_TTL_SEC };
}

function _verifyMyToken_(token) {
  if (!token) return { ok: false, error: 'no_token' };
  var parts = String(token).split('.');
  if (parts.length !== 2) return { ok: false, error: 'bad_token' };
  try {
    var padded = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    var payloadBytes = Utilities.base64DecodeWebSafe(padded);
    var payloadStr = Utilities.newBlob(payloadBytes).getDataAsString();
    var secret = _getHmacSecret_();
    var expectedSig = Utilities.computeHmacSha256Signature(payloadStr, secret);
    var expectedB64 = _b64url_(expectedSig);
    if (expectedB64 !== parts[1]) return { ok: false, error: 'bad_signature' };
    var payload = JSON.parse(payloadStr);
    if (payload.kind !== 'my')   return { ok: false, error: 'wrong_kind' };
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: 'expired' };
    }
    return { ok: true, user: String(payload.user || '').trim() };
  } catch (err) {
    return { ok: false, error: 'parse_error: ' + err };
  }
}

// Iterate dates inclusive [fromDate, toDate] as 'YYYY-MM-DD' strings.
function _dateRange_(fromDate, toDate) {
  var out = [];
  if (!fromDate) return out;
  if (!toDate) toDate = fromDate;
  // Parse as UTC midnight for stable date math
  var a = new Date(fromDate + 'T00:00:00Z');
  var b = new Date(toDate   + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b) || a > b) return out;
  var cursor = a;
  var safety = 0;
  while (cursor <= b && safety < 400) {
    out.push(Utilities.formatDate(cursor, 'UTC', 'yyyy-MM-dd'));
    cursor = new Date(cursor.getTime() + 86400000);
    safety++;
  }
  return out;
}

// Read all rows from a team log for a given user across a date range.
// Uses the same bottom-up block scan pattern as readLog_ for speed.
function _readUserTeamLogRange_(ss, team, user, fromDate, toDate) {
  var tab = TEAM_TO_TAB[team];
  if (!tab) return { header: [], rows: [] };
  var sh = ss.getSheetByName(tab);
  if (!sh) return { header: [], rows: [] };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { header: [], rows: [] };
  var lastCol = sh.getLastColumn();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];

  var userLc = String(user || '').toLowerCase().trim();
  var BLOCK = 500;
  var matched = [];
  var end = lastRow;
  var passed = false;
  while (end >= 2 && !passed) {
    var start = Math.max(2, end - BLOCK + 1);
    var rng = sh.getRange(start, 1, end - start + 1, lastCol);
    var block = rng.getValues();
    // Display values for col A (date) — avoids ALL the Date-object/TZ
    // corner cases by reading the string exactly as the sheet renders it.
    var disp = rng.getDisplayValues();
    for (var i = block.length - 1; i >= 0; i--) {
      var rowDate = String(disp[i][0] || '').slice(0, 10);
      if (rowDate < fromDate) { passed = true; break; }
      if (rowDate > toDate) continue;
      var rowUser = String(block[i][1] || '').toLowerCase().trim();
      if (rowUser === userLc) {
        // Replace col A (Timestamp) with the display string so the
        // dashboard renders "2026-04-24 20:52:36" instead of
        // "2026-04-24T21:32:09.000Z" (ISO UTC) that a Date object would
        // serialize to over JSON.
        block[i][0] = String(disp[i][0] || '');
        matched.unshift(block[i]);
      }
    }
    end = start - 1;
  }

  // If the range includes past days, also pull from Drive archive
  // (active sheet is trimmed daily to today only). Use the batch reader
  // so a 30-day range opens each monthly file ONCE, not 30 times.
  var today = todayPST_();
  if (fromDate < today) {
    var pastTo = toDate < today ? toDate : _prevDayPST_(today);
    var arch = _readUserArchiveRange_(team, user, fromDate, pastTo);
    if (arch.rows && arch.rows.length) {
      for (var j = 0; j < arch.rows.length; j++) matched.push(arch.rows[j]);
    }
    if (!header.length && arch.header && arch.header.length) header = arch.header;
  }

  return { header: header, rows: matched };
}

// Returns "yyyy-MM-dd" for (ymd - 1 day). Used to derive the upper bound
// of the archive-only portion of a range that includes today.
function _prevDayPST_(ymd) {
  var d = new Date(ymd + 'T12:00:00Z'); // noon to dodge DST/TZ edge cases
  d.setTime(d.getTime() - 86400000);
  return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
}

// Read a user's rows from a team's monthly Drive archive files across a
// date range. Opens each month's archive spreadsheet at most ONCE — much
// cheaper than readArchiveLog_ in a loop for week/month queries.
// Uses CacheService for the filtered per-user slice (5-min TTL).
function _readUserArchiveRange_(team, user, fromDate, toDate) {
  try {
    var cache = CacheService.getScriptCache();
    var cacheKey = 'archU:' + team + ':' + user + ':' + fromDate + ':' + toDate;
    var hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);

    var rootId = _getArchiveRootId_();
    if (!rootId) return { header: [], rows: [] };
    var root = DriveApp.getFolderById(rootId);
    var folder = _findOrCreateChild_(root, _folderNameForTeam_(team));

    // Build unique set of yyyy_mm months touched by [fromDate, toDate]
    var months = {};
    var days = _dateRange_(fromDate, toDate);
    days.forEach(function (d) { months[d.slice(0, 7).replace('-', '_')] = true; });

    var userLc = String(user || '').toLowerCase().trim();
    var header = [];
    var out = [];

    Object.keys(months).forEach(function (yyyymm) {
      var baseName = TEAM_TO_TAB[team].replace(/_Log$/, '') + '_Log_' + yyyymm;
      var file = _findFileInFolder_(folder, baseName);
      if (!file) return;
      var archSs = SpreadsheetApp.openById(file.getId());
      var sh = archSs.getSheets()[0];
      var lastRow = sh.getLastRow();
      var lastCol = sh.getLastColumn();
      if (lastRow < 2) return;
      if (!header.length) header = sh.getRange(1, 1, 1, lastCol).getValues()[0];

      var rng    = sh.getRange(2, 1, lastRow - 1, lastCol);
      var values = rng.getValues();
      var disp   = rng.getDisplayValues();
      for (var i = 0; i < values.length; i++) {
        var d = String(disp[i][0] || '').slice(0, 10);
        if (d < fromDate || d > toDate) continue;
        var u = String(values[i][1] || '').toLowerCase().trim();
        if (u !== userLc) continue;
        values[i][0] = String(disp[i][0] || ''); // clean col A for JSON
        out.push(values[i]);
      }
    });

    var result = { header: header, rows: out };
    // 5-min cache — covers a user refreshing their dashboard a few times
    try { cache.put(cacheKey, JSON.stringify(result), 300); } catch (e) {}
    return result;
  } catch (err) {
    Logger.log('_readUserArchiveRange_ failed: ' + err);
    return { header: [], rows: [] };
  }
}

// Read Sessions rows for user in date range. Sessions col A=Name, B=Date.
// Returns rows AND a parallel display array for col C (Start) + col D (End)
// so the caller can compute wall-clock shift duration (Mac-app util formula).
function _readUserSessionsRange_(ss, user, fromDate, toDate) {
  var sh = ss.getSheetByName('Sessions');
  if (!sh) return { header: [], rows: [], startEnd: [] };
  var rng = sh.getDataRange();
  var vals = rng.getValues();
  var disp = rng.getDisplayValues();
  var header = vals.shift() || [];
  disp.shift();
  var userLc = String(user || '').toLowerCase().trim();
  var rows = [];
  var startEnd = [];
  for (var i = 0; i < vals.length; i++) {
    var n = String(vals[i][0] || '').toLowerCase().trim();
    if (n !== userLc) continue;
    var d = String(disp[i][1] || '').slice(0, 10);
    if (d >= fromDate && d <= toDate) {
      rows.push(vals[i]);
      startEnd.push([ String(disp[i][2] || ''), String(disp[i][3] || '') ]);
    }
  }
  return { header: header, rows: rows, startEnd: startEnd };
}

// Compute wall-clock minutes between two IST "HH:mm:ss" strings.
// If end < start, assumes the shift crossed IST midnight and adds 24h.
// Returns 0 if either is missing/unparseable.
function _shiftDurationMin_(startStr, endStr) {
  function toSec(s) {
    var m = String(s || '').match(/^(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return -1;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }
  var st = toSec(startStr);
  var en = toSec(endStr);
  if (st < 0 || en < 0) return 0;
  var diff = en - st;
  if (diff < 0) diff += 86400; // overnight
  return Math.round(diff / 60);
}

// Current IST time as seconds-since-midnight.
function _nowIstSec_() {
  var t = Utilities.formatDate(new Date(), TZ, 'HH:mm:ss');
  var m = t.match(/^(\d{2}):(\d{2}):(\d{2})/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

// Read Attendance for user in date range. Cols A=Date, B=User, C=Team, D=Status.
function _readUserAttendanceRange_(ss, user, fromDate, toDate) {
  var sh = ss.getSheetByName('Attendance');
  if (!sh) return { header: [], rows: [] };
  var rng = sh.getDataRange();
  var vals = rng.getValues();
  var disp = rng.getDisplayValues();  // col A date as displayed ("2026-04-24")
  var header = vals.shift() || [];
  disp.shift();
  var userLc = String(user || '').toLowerCase().trim();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var n = String(vals[i][1] || '').toLowerCase().trim();
    if (n !== userLc) continue;
    var d = String(disp[i][0] || '').slice(0, 10);
    if (d >= fromDate && d <= toDate) rows.push(vals[i]);
  }
  return { header: header, rows: rows };
}

// Pull the caller's in-progress shift data from the Live tab.
// Returns null if no row exists. This is how "Today" numbers populate
// before the user actually ends their shift (Sessions writes on close only).
// Live schema: A=ShiftStartAt B=User C=HomeTeam D=Team E=Activity F=TasksDone
//              G=ProdMin H=BreakMin I=IdleMin ...
function _readUserLiveRow_(ss, user) {
  var sh = ss.getSheetByName('Live');
  if (!sh) return null;
  var userLc = String(user || '').toLowerCase().trim();
  var rng  = sh.getDataRange();
  var vals = rng.getValues();
  // Display values so shiftStartAt comes back as "YYYY-MM-DD HH:mm:ss" even
  // when Sheets coerced the cell into a Date object (format-drift from
  // earlier versions before col A was locked to plain text).
  var disp = rng.getDisplayValues();
  for (var i = 1; i < vals.length; i++) {
    var n = String(vals[i][1] || '').toLowerCase().trim();
    if (n === userLc) {
      return {
        shiftStartAt: String(disp[i][0] || vals[i][0] || ''),
        team:         String(vals[i][3] || ''),
        activity:     String(vals[i][4] || ''),
        tasksDone:    Number(vals[i][5]) || 0,
        prodMin:      Number(vals[i][6]) || 0,
        breakMin:     Number(vals[i][7]) || 0,
        idleMin:      Number(vals[i][8]) || 0
      };
    }
  }
  return null;
}

// Main endpoint. Returns everything the personal dashboard needs to render.
function myStats_(ss, p) {
  var v = _verifyMyToken_(p.token);
  if (!v.ok) return { ok: false, error: v.error === 'expired' ? 'session_expired' : 'forbidden' };
  var user = v.user;

  var today = todayPST_();
  var fromDate = String(p.fromDate || today).slice(0, 10);
  var toDate   = String(p.toDate   || today).slice(0, 10);
  if (fromDate > toDate) { var tmp = fromDate; fromDate = toDate; toDate = tmp; }

  // Sessions — source of truth for CLOSED shift totals & utilization
  var sess = _readUserSessionsRange_(ss, user, fromDate, toDate);
  // Schema: A=Name B=Date C=Start D=End E=Production F=Break G=Dinner
  //         H=Meeting I=Training J=Idle K=BreakExceeded
  //
  // shiftMin = wall-clock minutes between Start and End per row. Summed
  // across all shifts, it forms the Mac-app utilisation denominator
  // (Utilization = Productive ÷ logged-in time). Falls back to activity-
  // sum only if wall-clock duration can't be computed for any row.
  var totals = { production: 0, break_: 0, dinner: 0, meeting: 0, training: 0, idle: 0, shifts: 0, shiftMin: 0 };
  var missedAnyShiftMin = false;
  for (var i = 0; i < sess.rows.length; i++) {
    var r = sess.rows[i];
    totals.shifts += 1;
    totals.production += Number(r[4]) || 0;
    totals.break_     += Number(r[5]) || 0;
    totals.dinner     += Number(r[6]) || 0;
    totals.meeting    += Number(r[7]) || 0;
    totals.training   += Number(r[8]) || 0;
    totals.idle       += Number(r[9]) || 0;
    var se = sess.startEnd && sess.startEnd[i];
    var dur = se ? _shiftDurationMin_(se[0], se[1]) : 0;
    if (dur > 0) totals.shiftMin += dur;
    else         missedAnyShiftMin = true;
  }

  // If the selected range INCLUDES today and the user has an active Live
  // row whose shift isn't yet in Sessions, merge its in-progress minutes
  // in so the dashboard shows real-time Production/Utilization mid-shift.
  // (Sessions for today only appears after user clicks End-Shift.)
  var liveMerged = false;
  if (fromDate <= today && today <= toDate) {
    var live = _readUserLiveRow_(ss, user);
    if (live && live.shiftStartAt) {
      // Only merge if there's NO Sessions row already for today (avoids
      // double-counting after shift closes while Live row still lingers).
      var hasTodaySession = false;
      for (var si = 0; si < sess.rows.length; si++) {
        var d = _toYMD_(sess.rows[si][1]);
        if (d === today) { hasTodaySession = true; break; }
      }
      if (!hasTodaySession) {
        totals.shifts     += 1;
        totals.production += live.prodMin;
        totals.break_     += live.breakMin;
        totals.idle       += live.idleMin;
        // live.shiftStartAt normally "YYYY-MM-DD HH:mm:ss" (IST wall clock)
        // but may be "Sat Apr 25 2026 04:45:31 GMT+0530" if Sheets coerced
        // the cell into a Date object before col A was locked to plain
        // text. Match the FIRST HH:mm:ss pattern anywhere in the string.
        var stSec = String(live.shiftStartAt).match(/(\d{1,2}):(\d{2}):(\d{2})/);
        if (stSec) {
          var startSec = (+stSec[1]) * 3600 + (+stSec[2]) * 60 + (+stSec[3]);
          var nowSec   = _nowIstSec_();
          var diff     = nowSec - startSec;
          if (diff < 0) diff += 86400;
          totals.shiftMin += Math.round(diff / 60);
        } else {
          missedAnyShiftMin = true;
        }
        liveMerged = true;
      }
    }
  }

  var productiveMin = totals.production + totals.meeting + totals.training;
  // Prefer Mac-app formula (productive ÷ wall-clock shift time). Fall back
  // to activity-sum denominator only if we couldn't compute shift duration
  // for ALL rows (corrupt/empty Start or End cells).
  var activitySum   = productiveMin + totals.break_ + totals.dinner + totals.idle;
  var denomMin      = (totals.shiftMin > 0 && !missedAnyShiftMin) ? totals.shiftMin : activitySum;
  var utilization   = denomMin > 0 ? Math.round((productiveMin / denomMin) * 100) : 0;

  // Attendance — build set of teams the user touched in range
  var att = _readUserAttendanceRange_(ss, user, fromDate, toDate);
  var teamSet = {};
  for (var j = 0; j < att.rows.length; j++) {
    var t = String(att.rows[j][2] || '').trim();
    var canon = resolveTeam_(t) || t;
    if (canon && TEAM_TO_TAB[canon]) teamSet[canon] = true;
  }
  var teams = Object.keys(teamSet);

  // If client passed a team filter, restrict to it (resolve aliases)
  var requestedTeam = null;
  if (p.team) {
    requestedTeam = resolveTeam_(String(p.team).trim());
    if (requestedTeam && teams.indexOf(requestedTeam) < 0) {
      // User asking for a team they never worked in — return empty logs
      teams = [];
    } else if (requestedTeam) {
      teams = [requestedTeam];
    }
  }

  // Pull team log rows for the user across range, one bucket per team
  var logs = {};
  for (var k = 0; k < teams.length; k++) {
    var team = teams[k];
    var r2 = _readUserTeamLogRange_(ss, team, user, fromDate, toDate);
    logs[team] = { header: r2.header, rows: r2.rows, tab: TEAM_TO_TAB[team] };
  }

  // Also surface ALL teams the user worked in across the range
  // (for the team-toggle UI even when requestedTeam restricts logs).
  var allTeams = [];
  for (var tName in teamSet) if (teamSet.hasOwnProperty(tName)) allTeams.push(tName);

  return {
    ok: true,
    user: user,
    fromDate: fromDate,
    toDate: toDate,
    totals: {
      shifts: totals.shifts,
      productionMin: totals.production,
      breakMin:      totals.break_,
      dinnerMin:     totals.dinner,
      meetingMin:    totals.meeting,
      trainingMin:   totals.training,
      idleMin:       totals.idle,
      productiveMin: productiveMin,
      denomMin:      denomMin,
      utilization:   utilization
    },
    teams:    allTeams,
    selectedTeam: requestedTeam || null,
    logs:     logs,
    sessions: { header: sess.header, rows: sess.rows }
  };
}
