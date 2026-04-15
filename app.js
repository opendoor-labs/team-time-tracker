// ══════════════════════════════════════════════
// TEAM TIME TRACKER v2 — Enhanced
// Features:
//   ✅ Mandatory Production click to start
//   ✅ 15-min inactivity → auto-Break
//   ✅ Lunch/Dinner as separate activity
//   ✅ Break time tracking with exceeded alert
//   ✅ Google Sheets sync
//   ✅ Fullscreen mode to keep focus
// ══════════════════════════════════════════════

// ── State ──
let userName = '';
let sheetUrl = '';
let shiftStartTime = null;
let currentActivity = null;
let currentActivityStart = null;
let activityLog = [];
let productionStarted = false; // Has user clicked Production at least once?
let autoBreakTriggered = false; // Is current break due to inactivity?

// Cumulative seconds per activity
let totals = {
  Production: 0,
  Break: 0,
  'Lunch/Dinner': 0,
  Meeting: 0,
  Training: 0
};

// ── Inactivity Tracking ──
const IDLE_TIMEOUT = 15 * 60; // 15 minutes in seconds
let lastActivityTimestamp = Date.now();
let idleSeconds = 0;

// ── DOM Elements ──
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const nameInput = document.getElementById('nameInput');
const btnStart = document.getElementById('btnStart');
const settingsLink = document.getElementById('settingsLink');
const settingsModal = document.getElementById('settingsModal');
const sheetUrlInput = document.getElementById('sheetUrlInput');
const btnSettingsSave = document.getElementById('btnSettingsSave');
const btnSettingsCancel = document.getElementById('btnSettingsCancel');
const welcomeUser = document.getElementById('welcomeUser');
const shiftElapsed = document.getElementById('shiftElapsed');
const currentActivityName = document.getElementById('currentActivityName');
const currentTimer = document.getElementById('currentTimer');
const breakTimeDisplay = document.getElementById('breakTimeDisplay');
const breakBarFill = document.getElementById('breakBarFill');
const breakExceeded = document.getElementById('breakExceeded');
const logBody = document.getElementById('logBody');
const btnEndShift = document.getElementById('btnEndShift');
const mandatoryOverlay = document.getElementById('mandatoryOverlay');
const btnForceProduction = document.getElementById('btnForceProduction');
const inactivityBanner = document.getElementById('inactivityBanner');
const btnResume = document.getElementById('btnResume');
const idleBadge = document.getElementById('idleBadge');
const idleTimerEl = document.getElementById('idleTimer');

const activityButtons = {
  Production: document.getElementById('btnProduction'),
  Break: document.getElementById('btnBreak'),
  'Lunch/Dinner': document.getElementById('btnLunch'),
  Meeting: document.getElementById('btnMeeting'),
  Training: document.getElementById('btnTraining')
};

const activityTimerEls = {
  Production: document.getElementById('timerProduction'),
  Break: document.getElementById('timerBreak'),
  'Lunch/Dinner': document.getElementById('timerLunch'),
  Meeting: document.getElementById('timerMeeting'),
  Training: document.getElementById('timerTraining')
};

const summaryEls = {
  Production: document.getElementById('summaryProduction'),
  Break: document.getElementById('summaryBreak'),
  'Lunch/Dinner': document.getElementById('summaryLunch'),
  Meeting: document.getElementById('summaryMeeting'),
  Training: document.getElementById('summaryTraining')
};

// ── Utilities ──
function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimeShort(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimeForLog(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

function activityCssClass(activity) {
  return activity.toLowerCase().replace(/\//g, '-');
}

// ── Load saved settings ──
function loadSettings() {
  const savedName = localStorage.getItem('tracker_userName');
  const savedUrl = localStorage.getItem('tracker_sheetUrl');
  if (savedName) nameInput.value = savedName;
  if (savedUrl) {
    sheetUrl = savedUrl;
    sheetUrlInput.value = savedUrl;
  }
}

// ══════════════════════════════════════════════
// LOGIN
// ══════════════════════════════════════════════
nameInput.addEventListener('input', () => {
  btnStart.disabled = nameInput.value.trim().length === 0;
});

btnStart.addEventListener('click', () => {
  userName = nameInput.value.trim();
  if (!userName) return;
  localStorage.setItem('tracker_userName', userName);
  startShift();
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && nameInput.value.trim()) {
    btnStart.click();
  }
});

// ── Settings Modal ──
settingsLink.addEventListener('click', () => {
  settingsModal.classList.add('active');
  sheetUrlInput.value = sheetUrl;
});

btnSettingsCancel.addEventListener('click', () => {
  settingsModal.classList.remove('active');
});

btnSettingsSave.addEventListener('click', () => {
  sheetUrl = sheetUrlInput.value.trim();
  localStorage.setItem('tracker_sheetUrl', sheetUrl);
  settingsModal.classList.remove('active');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove('active');
});

// ══════════════════════════════════════════════
// START SHIFT
// ══════════════════════════════════════════════
function startShift() {
  loginScreen.style.display = 'none';
  dashboard.classList.add('active');
  welcomeUser.textContent = `Welcome, ${userName}`;
  shiftStartTime = new Date();
  productionStarted = false;

  // Show MANDATORY overlay — blocks everything
  mandatoryOverlay.classList.add('active');

  // Try fullscreen
  requestFullscreen();

  startTicker();
  startIdleTracking();
}

// ══════════════════════════════════════════════
// MANDATORY PRODUCTION — Must click to start
// ══════════════════════════════════════════════
btnForceProduction.addEventListener('click', () => {
  mandatoryOverlay.classList.remove('active');
  productionStarted = true;
  switchActivity('Production');
  resetIdleTimer();
});

// ══════════════════════════════════════════════
// ACTIVITY SWITCHING
// ══════════════════════════════════════════════
Object.entries(activityButtons).forEach(([activity, btn]) => {
  btn.addEventListener('click', () => {
    // If Production hasn't been started yet, block everything
    if (!productionStarted) {
      mandatoryOverlay.classList.add('active');
      return;
    }
    switchActivity(activity);
    resetIdleTimer();
    // Clear auto-break banner if user manually switches
    if (autoBreakTriggered) {
      autoBreakTriggered = false;
      inactivityBanner.classList.remove('active');
    }
  });
});

function switchActivity(newActivity, isAutoBreak = false) {
  const now = new Date();

  // End current activity
  if (currentActivity) {
    const elapsed = (now - currentActivityStart) / 1000;
    totals[currentActivity] += elapsed;

    const logEntry = {
      activity: currentActivity,
      start: currentActivityStart,
      end: now,
      duration: elapsed,
      type: (currentActivity === 'Break' && autoBreakTriggered) ? 'Auto' : 'Manual'
    };
    activityLog.push(logEntry);
    addLogRow(logEntry);
    sendToSheet(logEntry);

    activityButtons[currentActivity].classList.remove('active');
  }

  // Start new activity
  currentActivity = newActivity;
  currentActivityStart = now;
  autoBreakTriggered = isAutoBreak;
  activityButtons[newActivity].classList.add('active');

  // Update current activity display
  currentActivityName.textContent = newActivity;
  currentActivityName.className = `activity-name activity-${activityCssClass(newActivity)}`;
  currentTimer.className = `timer activity-${activityCssClass(newActivity)}`;
}

// ══════════════════════════════════════════════
// INACTIVITY DETECTION — Auto-Break after 15 min
// ══════════════════════════════════════════════
function resetIdleTimer() {
  lastActivityTimestamp = Date.now();
  idleSeconds = 0;
}

function startIdleTracking() {
  // Track mouse movement, keyboard, clicks, scroll
  const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
  events.forEach(evt => {
    document.addEventListener(evt, () => {
      resetIdleTimer();
    }, { passive: true });
  });
}

function checkIdleState() {
  if (!shiftStartTime || !productionStarted) return;

  idleSeconds = Math.floor((Date.now() - lastActivityTimestamp) / 1000);

  // Update idle badge in header
  idleTimerEl.textContent = formatTimeShort(idleSeconds);

  // Visual warnings
  if (idleSeconds >= IDLE_TIMEOUT * 0.8) { // 12 min — danger
    idleBadge.className = 'idle-badge danger';
  } else if (idleSeconds >= IDLE_TIMEOUT * 0.5) { // 7.5 min — warning
    idleBadge.className = 'idle-badge warning';
  } else {
    idleBadge.className = 'idle-badge';
  }

  // AUTO-BREAK trigger at 15 minutes
  if (idleSeconds >= IDLE_TIMEOUT && currentActivity !== 'Break' && currentActivity !== 'Lunch/Dinner') {
    triggerAutoBreak();
  }
}

function triggerAutoBreak() {
  // Switch to Break automatically
  switchActivity('Break', true);

  // Show the red banner
  inactivityBanner.classList.add('active');

  // Play alert sound (beep)
  playAlertSound();

  // Reset idle timer so it doesn't re-trigger immediately
  resetIdleTimer();
}

// Resume Production button on the inactivity banner
btnResume.addEventListener('click', () => {
  inactivityBanner.classList.remove('active');
  autoBreakTriggered = false;
  switchActivity('Production');
  resetIdleTimer();
});

// Simple beep sound using Web Audio API
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    setTimeout(() => {
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.value = 1000;
      gain2.gain.value = 0.3;
      osc2.start();
      osc2.stop(ctx.currentTime + 0.3);
    }, 400);
  } catch (e) {
    // Audio not supported
  }
}

// ══════════════════════════════════════════════
// FULLSCREEN — Keeps agents focused
// ══════════════════════════════════════════════
function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else if (el.msRequestFullscreen) el.msRequestFullscreen();
}

// Re-prompt fullscreen if user exits it
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && shiftStartTime && productionStarted) {
    // Small delay then re-request
    setTimeout(() => {
      if (shiftStartTime) requestFullscreen();
    }, 2000);
  }
});

// ══════════════════════════════════════════════
// END SHIFT
// ══════════════════════════════════════════════
btnEndShift.addEventListener('click', () => {
  if (!currentActivity) {
    resetToLogin();
    return;
  }

  const now = new Date();
  const elapsed = (now - currentActivityStart) / 1000;
  totals[currentActivity] += elapsed;

  const logEntry = {
    activity: currentActivity,
    start: currentActivityStart,
    end: now,
    duration: elapsed,
    type: (currentActivity === 'Break' && autoBreakTriggered) ? 'Auto' : 'Manual'
  };
  activityLog.push(logEntry);
  addLogRow(logEntry);
  sendToSheet(logEntry);

  sendShiftSummary();
  resetToLogin();

  // Exit fullscreen
  if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
});

function resetToLogin() {
  dashboard.classList.remove('active');
  mandatoryOverlay.classList.remove('active');
  inactivityBanner.classList.remove('active');
  loginScreen.style.display = 'flex';
  currentActivity = null;
  currentActivityStart = null;
  shiftStartTime = null;
  productionStarted = false;
  autoBreakTriggered = false;
  activityLog = [];
  totals = { Production: 0, Break: 0, 'Lunch/Dinner': 0, Meeting: 0, Training: 0 };
  logBody.innerHTML = '';
  currentActivityName.textContent = 'Not Started';
  currentActivityName.className = 'activity-name';
  currentTimer.textContent = '00:00:00';
  currentTimer.className = 'timer';
  breakBarFill.style.width = '0%';
  breakBarFill.classList.remove('exceeded');
  breakExceeded.classList.remove('visible');
  breakTimeDisplay.classList.remove('exceeded');
  breakTimeDisplay.style.color = '';
  idleBadge.className = 'idle-badge';
  idleTimerEl.textContent = '00:00';
  Object.values(activityButtons).forEach(btn => btn.classList.remove('active'));
}

// ══════════════════════════════════════════════
// TICKER — Updates every second
// ══════════════════════════════════════════════
function startTicker() {
  setInterval(() => {
    if (!shiftStartTime) return;
    const now = new Date();

    // Shift elapsed
    const shiftSec = (now - shiftStartTime) / 1000;
    shiftElapsed.textContent = formatTime(shiftSec);

    // Current activity timer
    if (currentActivity && currentActivityStart) {
      const actSec = (now - currentActivityStart) / 1000;
      currentTimer.textContent = formatTime(actSec);
    }

    // Update all totals displays
    Object.keys(totals).forEach(act => {
      let total = totals[act];
      if (currentActivity === act && currentActivityStart) {
        total += (now - currentActivityStart) / 1000;
      }
      if (activityTimerEls[act]) activityTimerEls[act].textContent = formatTime(total);
      if (summaryEls[act]) summaryEls[act].textContent = formatTime(total);
    });

    // Break tracker (combines Break + Lunch/Dinner)
    let breakTotal = totals.Break;
    if (currentActivity === 'Break' && currentActivityStart) {
      breakTotal += (now - currentActivityStart) / 1000;
    }
    const breakMinutes = breakTotal / 60;
    const breakAllowed = 60; // minutes
    const pct = Math.min((breakMinutes / breakAllowed) * 100, 100);
    breakBarFill.style.width = `${pct}%`;

    const usedMin = Math.floor(breakTotal / 60);
    const usedSec = Math.floor(breakTotal % 60);
    breakTimeDisplay.textContent = `${String(usedMin).padStart(2, '0')}:${String(usedSec).padStart(2, '0')} / 60:00`;

    if (breakMinutes >= breakAllowed) {
      breakBarFill.classList.add('exceeded');
      breakTimeDisplay.classList.add('exceeded');
      const exceededMin = Math.floor(breakMinutes - breakAllowed);
      const exceededSec = Math.floor((breakTotal - breakAllowed * 60) % 60);
      breakExceeded.textContent = `Break Exceeded by ${exceededMin}m ${exceededSec}s!`;
      breakExceeded.classList.add('visible');
    } else if (breakMinutes >= 50) {
      breakTimeDisplay.style.color = '#f59e0b';
    }

    // Check idle state
    checkIdleState();
  }, 1000);
}

// ══════════════════════════════════════════════
// ACTIVITY LOG TABLE
// ══════════════════════════════════════════════
function addLogRow(entry) {
  const row = document.createElement('tr');
  if (entry.type === 'Auto') row.classList.add('log-auto-break');
  const dotClass = `dot-${activityCssClass(entry.activity)}`;
  const typeTag = entry.type === 'Auto'
    ? '<span class="auto-break-tag">AUTO</span>'
    : '<span class="manual-tag">MANUAL</span>';

  row.innerHTML = `
    <td><span class="log-dot ${dotClass}"></span>${entry.activity}</td>
    <td>${formatTimeForLog(entry.start)}</td>
    <td>${formatTimeForLog(entry.end)}</td>
    <td>${formatDuration(entry.duration)}</td>
    <td>${typeTag}</td>
  `;
  logBody.insertBefore(row, logBody.firstChild);
}

// ══════════════════════════════════════════════
// GOOGLE SHEETS SYNC
// ══════════════════════════════════════════════
async function sendToSheet(logEntry) {
  if (!sheetUrl) return;

  const breakTotal = totals.Break;
  const breakExceededFlag = breakTotal > 3600;

  const data = {
    name: userName,
    activity: logEntry.activity,
    startTime: logEntry.start.toISOString(),
    endTime: logEntry.end.toISOString(),
    durationSeconds: Math.round(logEntry.duration),
    durationFormatted: formatDuration(logEntry.duration),
    breakExceeded: breakExceededFlag,
    triggerType: logEntry.type || 'Manual',
    date: new Date().toLocaleDateString('en-IN')
  };

  try {
    await fetch(sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (err) {
    console.error('Failed to sync to Google Sheets:', err);
  }
}

async function sendShiftSummary() {
  if (!sheetUrl) return;

  const data = {
    type: 'shift_summary',
    name: userName,
    date: new Date().toLocaleDateString('en-IN'),
    shiftStart: shiftStartTime.toISOString(),
    shiftEnd: new Date().toISOString(),
    productionMinutes: Math.round(totals.Production / 60),
    breakMinutes: Math.round(totals.Break / 60),
    lunchDinnerMinutes: Math.round(totals['Lunch/Dinner'] / 60),
    meetingMinutes: Math.round(totals.Meeting / 60),
    trainingMinutes: Math.round(totals.Training / 60),
    breakExceeded: totals.Break > 3600,
    breakExceededBy: totals.Break > 3600 ? Math.round((totals.Break - 3600) / 60) : 0
  };

  try {
    await fetch(sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (err) {
    console.error('Failed to send shift summary:', err);
  }
}

// ══════════════════════════════════════════════
// PREVENT TAB CLOSE during shift
// ══════════════════════════════════════════════
window.addEventListener('beforeunload', (e) => {
  if (shiftStartTime) {
    e.preventDefault();
    e.returnValue = 'Your shift is still active! Are you sure you want to leave?';
    return e.returnValue;
  }
});

// ── Init ──
loadSettings();
