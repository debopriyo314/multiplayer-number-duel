import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, onSnapshot,
  runTransaction, serverTimestamp, deleteField, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------
// Firebase setup
// ---------------------------------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const STORAGE_KEY = 'duel_session_v1';
const HEARTBEAT_MS = 8000;
const STALE_MS = 20000;

let uid = null;
let roomCode = null;
let role = null; // 'player1' | 'player2'
let unsubscribeRoom = null;
let heartbeatTimer = null;
let latestRoomData = null;
let mySecretCache = {}; // { round1: number, round2: number }
let processingGuess = false;
let lastFeedbackKey = null; // avoid re-flashing same feedback on re-render

// ---------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const screens = {
  home: $('screen-home'),
  waiting: $('screen-waiting'),
  game: $('screen-game'),
  results: $('screen-results'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
  });
}

function showToast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function setPanel(id) {
  ['panel-set-secret', 'panel-setter-waiting', 'panel-guess', 'panel-round-done']
    .forEach(p => $(p).classList.toggle('hidden', p !== id));
}

// ---------------------------------------------------------------------
// Session persistence (reconnect on refresh)
// ---------------------------------------------------------------------
function saveSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, role }));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

// ---------------------------------------------------------------------
// Auth bootstrap
// ---------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); } catch (e) {
      showToast('Could not connect — check your Firebase config.');
      console.error(e);
    }
    return;
  }
  uid = user.uid;
  const saved = loadSession();
  if (saved && saved.roomCode) {
    roomCode = saved.roomCode;
    role = saved.role;
    const snap = await getDoc(doc(db, 'rooms', roomCode));
    if (snap.exists()) {
      attachRoomListener();
      startHeartbeat();
    } else {
      clearSession();
      showScreen('home');
    }
  } else {
    showScreen('home');
  }
});

// ---------------------------------------------------------------------
// Room code generation
// ---------------------------------------------------------------------
function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function generateUniqueRoomCode() {
  for (let i = 0; i < 8; i++) {
    const code = randomCode();
    const snap = await getDoc(doc(db, 'rooms', code));
    if (!snap.exists()) return code;
  }
  throw new Error('Could not allocate a room code, try again.');
}

// ---------------------------------------------------------------------
// Room creation / joining
// ---------------------------------------------------------------------
function freshRound(setterRole, guesserRole) {
  return {
    setterRole, guesserRole,
    phase: 'setting', // setting -> guessing -> done
    low: 1, high: 100,
    guesses: [],
    guessCount: 0,
    pendingGuess: null,
  };
}

async function createRoom() {
  if (!uid) return;
  $('btn-create-room').disabled = true;
  try {
    const code = await generateUniqueRoomCode();
    const roomRef = doc(db, 'rooms', code);
    await setDoc(roomRef, {
      code,
      createdAt: serverTimestamp(),
      status: 'waiting',
      player1Id: uid,
      player2Id: null,
      player1LastSeen: serverTimestamp(),
      player2LastSeen: null,
      currentRound: 1,
      round1: freshRound('player1', 'player2'),
      round2: freshRound('player2', 'player1'),
      overallWinner: null,
      rematch: { player1: false, player2: false },
    });
    roomCode = code;
    role = 'player1';
    saveSession();
    renderRoomCode(code);
    showScreen('waiting');
    attachRoomListener();
    startHeartbeat();
  } catch (e) {
    console.error(e);
    showToast(e.message || 'Failed to create room.');
  } finally {
    $('btn-create-room').disabled = false;
  }
}

async function joinRoom(codeInput) {
  const code = (codeInput || '').trim();
  const errEl = $('join-error');
  errEl.classList.add('hidden');
  if (!/^\d{6}$/.test(code)) {
    errEl.textContent = 'Enter the 6-digit room code.';
    errEl.classList.remove('hidden');
    return;
  }
  $('btn-join-submit').disabled = true;
  try {
    const roomRef = doc(db, 'rooms', code);
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error('NOT_FOUND');
      const data = snap.data();
      if (data.player2Id && data.player2Id !== uid) throw new Error('FULL');
      if (data.player1Id === uid) return 'self-as-1';
      tx.update(roomRef, {
        player2Id: uid,
        player2LastSeen: serverTimestamp(),
        status: 'playing',
      });
      return 'joined';
    });
    roomCode = code;
    role = result === 'self-as-1' ? 'player1' : 'player2';
    saveSession();
    attachRoomListener();
    startHeartbeat();
  } catch (e) {
    if (e.message === 'NOT_FOUND') errEl.textContent = "That room code doesn't exist.";
    else if (e.message === 'FULL') errEl.textContent = 'That room already has two players.';
    else { errEl.textContent = 'Something went wrong joining that room.'; console.error(e); }
    errEl.classList.remove('hidden');
  } finally {
    $('btn-join-submit').disabled = false;
  }
}

// ---------------------------------------------------------------------
// Live room listener + heartbeat
// ---------------------------------------------------------------------
function attachRoomListener() {
  if (unsubscribeRoom) unsubscribeRoom();
  const roomRef = doc(db, 'rooms', roomCode);
  unsubscribeRoom = onSnapshot(roomRef, (snap) => {
    if (!snap.exists()) {
      showToast('This room no longer exists.');
      resetToHome();
      return;
    }
    latestRoomData = snap.data();
    render(latestRoomData);
    maybeProcessPendingGuess(latestRoomData);
  }, (err) => {
    console.error(err);
    showToast('Connection interrupted. Retrying…');
  });
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  const field = role === 'player1' ? 'player1LastSeen' : 'player2LastSeen';
  const beat = () => updateDoc(doc(db, 'rooms', roomCode), { [field]: serverTimestamp() }).catch(() => {});
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}

function resetToHome() {
  clearSession();
  clearInterval(heartbeatTimer);
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = null;
  roomCode = null; role = null; latestRoomData = null; mySecretCache = {};
  showScreen('home');
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function renderRoomCode(code) {
  const digits = $('room-code-display').querySelectorAll('.digit');
  code.split('').forEach((d, i) => { if (digits[i]) digits[i].textContent = d; });
}

function opponentRole() { return role === 'player1' ? 'player2' : 'player1'; }

function render(data) {
  if (data.status === 'waiting') {
    renderRoomCode(data.code);
    showScreen('waiting');
    return;
  }

  const oppField = opponentRole() + 'LastSeen';
  const stale = isStale(data[oppField]);
  $('connection-note').classList.toggle('hidden', !stale || data.status === 'finished');

  if (data.status === 'finished') {
    renderResults(data);
    showScreen('results');
    return;
  }

  showScreen('game');
  renderRoundStrip(data);

  const roundKey = 'round' + data.currentRound;
  const round = data[roundKey];
  const iAmSetter = round.setterRole === role;

  if (round.phase === 'setting') {
    if (iAmSetter) {
      setPanel('panel-set-secret');
      $('set-secret-eyebrow').textContent = "You're setting the number";
    } else {
      setPanel('panel-setter-waiting');
      $('panel-setter-waiting').querySelector('h2').textContent = 'Opponent is choosing a secret…';
      $('setter-wait-count').textContent = '0';
      $('setter-guess-log').innerHTML = '';
    }
  } else if (round.phase === 'guessing') {
    if (iAmSetter) {
      setPanel('panel-setter-waiting');
      $('panel-setter-waiting').querySelector('h2').textContent = 'Your opponent is guessing…';
      $('setter-wait-count').textContent = String(round.guessCount);
      renderGuessLog($('setter-guess-log'), round.guesses);
    } else {
      setPanel('panel-guess');
      renderGuesserPanel(round);
    }
  } else if (round.phase === 'done') {
    setPanel('panel-round-done');
    renderRoundDone(data, round);
  }
}

function isStale(ts) {
  if (!ts) return false;
  const ms = ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : 0);
  return Date.now() - ms > STALE_MS;
}

function renderRoundStrip(data) {
  [1, 2].forEach(n => {
    const pill = $(`round-pill-${n}`);
    const round = data['round' + n];
    const stateEl = $(`round${n}-state`);
    pill.classList.remove('is-active', 'is-done');
    if (data.currentRound === n && data.status !== 'finished') pill.classList.add('is-active');
    if (round.phase === 'done') {
      pill.classList.add('is-done');
      stateEl.textContent = `${round.guessCount} guesses`;
    } else if (data.currentRound === n) {
      stateEl.textContent = round.phase === 'setting' ? 'setting…' : 'guessing…';
    } else {
      stateEl.textContent = '—';
    }
  });
}

function renderGuessLog(container, guesses) {
  container.innerHTML = '';
  guesses.forEach(g => {
    const chip = document.createElement('span');
    chip.className = 'guess-chip ' + g.feedback;
    const arrow = g.feedback === 'higher' ? '↑' : g.feedback === 'lower' ? '↓' : '✓';
    chip.textContent = `${g.value} ${arrow}`;
    container.appendChild(chip);
  });
  container.scrollTop = container.scrollHeight;
}

function renderGuesserPanel(round) {
  $('guess-count').textContent = String(round.guessCount);
  $('guess-range-size').textContent = String(Math.max(0, round.high - round.low + 1));
  $('range-low-label').textContent = String(round.low);
  $('range-high-label').textContent = String(round.high);

  const pct = (v) => ((v - 1) / 99) * 100;
  const left = pct(round.low);
  const right = 100 - pct(round.high);
  $('range-fill').style.left = left + '%';
  $('range-fill').style.right = right + '%';
  $('range-marker').style.left = pct((round.low + round.high) / 2) + '%';

  renderGuessLog($('guess-log'), round.guesses);

  const last = round.guesses[round.guesses.length - 1];
  const key = round.guesses.length + ':' + (last ? last.feedback : '');
  if (last && key !== lastFeedbackKey) {
    lastFeedbackKey = key;
    flashFeedback(last.feedback);
  }

  const submitting = $('guess-input').disabled;
  if (!submitting) $('guess-input').value = '';
  $('guess-input').disabled = false;
  $('guess-submit').disabled = false;
}

function flashFeedback(feedback) {
  const el = $('feedback-flash');
  el.className = 'feedback-flash show ' + feedback;
  el.textContent = feedback === 'higher' ? 'Higher ↑' : feedback === 'lower' ? 'Lower ↓' : 'Correct!';
  clearTimeout(flashFeedback._t);
  flashFeedback._t = setTimeout(() => el.classList.remove('show'), 1600);
}

function renderRoundDone(data, round) {
  const iWasGuesser = round.guesserRole === role;
  $('round-done-heading').textContent = iWasGuesser
    ? `You found it in ${round.guessCount} guesses.`
    : `They found your number in ${round.guessCount} guesses.`;

  const isLastRound = data.currentRound === 2;
  $('round-done-copy').textContent = isLastRound
    ? 'Both rounds are in — tallying the result.'
    : 'Roles are about to switch for round two.';

  const btn = $('btn-continue-round');
  btn.textContent = isLastRound ? 'See results' : 'Continue to Round 2';
  btn.onclick = () => advanceRound(data);
}

function renderResults(data) {
  const r1 = data.round1, r2 = data.round2;
  // round1.guessCount = attempts by player2 (guesser) to find player1's number
  // round2.guessCount = attempts by player1 (guesser) to find player2's number
  const myCount = role === 'player1' ? r2.guessCount : r1.guessCount;
  const oppCount = role === 'player1' ? r1.guessCount : r2.guessCount;

  $('results-name-1').textContent = 'You';
  $('results-name-2').textContent = 'Opponent';
  $('results-count-1').textContent = String(myCount);
  $('results-count-2').textContent = String(oppCount);

  $('results-side-1').classList.remove('is-winner');
  $('results-side-2').classList.remove('is-winner');

  const iWon = data.overallWinner === role;
  const draw = data.overallWinner === 'draw';

  if (draw) {
    $('results-headline').textContent = "It's a draw.";
    $('results-eyebrow').textContent = 'Even match';
  } else if (iWon) {
    $('results-headline').textContent = 'You win the duel! 🎉';
    $('results-eyebrow').textContent = 'Victory';
    $('results-side-1').classList.add('is-winner');
    if (!renderResults._fired) { renderResults._fired = true; launchConfetti(); }
  } else {
    $('results-headline').textContent = 'Opponent wins this one.';
    $('results-eyebrow').textContent = 'Duel complete';
    $('results-side-2').classList.add('is-winner');
  }

  const myReady = data.rematch[role];
  const oppReady = data.rematch[opponentRole()];
  $('rematch-note').classList.toggle('hidden', !(myReady && !oppReady));
  $('btn-play-again').disabled = myReady;
  $('btn-play-again').textContent = myReady ? 'Waiting for opponent…' : 'Play Again';

  if (myReady && oppReady) {
    renderResults._fired = false;
  }
}

// ---------------------------------------------------------------------
// Setter: submit secret
// ---------------------------------------------------------------------
async function submitSecret(value) {
  const errEl = $('secret-error');
  errEl.classList.add('hidden');
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    errEl.textContent = 'Pick a whole number between 1 and 100.';
    errEl.classList.remove('hidden');
    return;
  }
  const roundKey = 'round' + latestRoomData.currentRound;
  mySecretCache[roundKey] = n;
  try {
    await setDoc(doc(db, 'rooms', roomCode, 'secrets', roundKey), {
      setterId: uid,
      number: n,
    });
    await updateDoc(doc(db, 'rooms', roomCode), {
      [`${roundKey}.phase`]: 'guessing',
    });
    $('secret-input').value = '';
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Could not lock in your number — try again.';
    errEl.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------
// Guesser: submit guess
// ---------------------------------------------------------------------
async function submitGuess(value) {
  const errEl = $('guess-error');
  errEl.classList.add('hidden');
  const round = latestRoomData['round' + latestRoomData.currentRound];
  const n = Number(value);
  if (!Number.isInteger(n) || n < round.low || n > round.high) {
    errEl.textContent = `Enter a number between ${round.low} and ${round.high}.`;
    errEl.classList.remove('hidden');
    return;
  }
  $('guess-input').disabled = true;
  $('guess-submit').disabled = true;
  const roundKey = 'round' + latestRoomData.currentRound;
  try {
    await updateDoc(doc(db, 'rooms', roomCode), {
      [`${roundKey}.pendingGuess`]: { value: n, by: uid, at: Date.now() },
    });
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Could not send your guess — try again.';
    errEl.classList.remove('hidden');
    $('guess-input').disabled = false;
    $('guess-submit').disabled = false;
  }
}

// ---------------------------------------------------------------------
// Setter side: resolve a pending guess against the secret
// ---------------------------------------------------------------------
async function maybeProcessPendingGuess(data) {
  const roundKey = 'round' + data.currentRound;
  const round = data[roundKey];
  if (!round || round.phase !== 'guessing') return;
  if (round.setterRole !== role) return;
  if (!round.pendingGuess) return;
  if (processingGuess) return;

  processingGuess = true;
  try {
    let secret = mySecretCache[roundKey];
    if (secret === undefined) {
      const secretSnap = await getDoc(doc(db, 'rooms', roomCode, 'secrets', roundKey));
      if (!secretSnap.exists()) { processingGuess = false; return; }
      secret = secretSnap.data().number;
      mySecretCache[roundKey] = secret;
    }

    const roomRef = doc(db, 'rooms', roomCode);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      const cur = snap.data();
      const r = cur[roundKey];
      if (!r.pendingGuess) return; // already handled
      const guessVal = r.pendingGuess.value;
      let feedback, low = r.low, high = r.high, phase = r.phase, winnerFound = false;
      if (guessVal === secret) {
        feedback = 'correct'; phase = 'done'; winnerFound = true;
      } else if (guessVal < secret) {
        feedback = 'higher'; low = Math.max(low, guessVal + 1);
      } else {
        feedback = 'lower'; high = Math.min(high, guessVal - 1);
      }
      const guesses = [...r.guesses, { value: guessVal, feedback }];
      const update = {
        [`${roundKey}.guesses`]: guesses,
        [`${roundKey}.guessCount`]: guesses.length,
        [`${roundKey}.low`]: low,
        [`${roundKey}.high`]: high,
        [`${roundKey}.phase`]: phase,
        [`${roundKey}.pendingGuess`]: null,
      };
      if (winnerFound && cur.currentRound === 2) {
        const other = cur.round1;
        const r1Count = roundKey === 'round1' ? guesses.length : other.guessCount;
        const r2Count = roundKey === 'round2' ? guesses.length : other.guessCount;
        let overallWinner;
        if (r1Count < r2Count) overallWinner = 'player2'; // player2 guessed round1 in fewer
        else if (r2Count < r1Count) overallWinner = 'player1';
        else overallWinner = 'draw';
        update.overallWinner = overallWinner;
        update.status = 'finished';
      }
      tx.update(roomRef, update);
    });
  } catch (e) {
    console.error('process guess failed', e);
  } finally {
    processingGuess = false;
  }
}

// ---------------------------------------------------------------------
// Round advance / rematch
// ---------------------------------------------------------------------
async function advanceRound(data) {
  if (data.currentRound === 1) {
    await updateDoc(doc(db, 'rooms', roomCode), { currentRound: 2 }).catch(() => {});
  }
  // if currentRound === 2 and phase done, status becomes 'finished' already via processGuess
}

async function playAgain() {
  const roomRef = doc(db, 'rooms', roomCode);
  await updateDoc(roomRef, { [`rematch.${role}`]: true }).catch(() => {});
  const fresh = (await getDoc(roomRef)).data();
  if (fresh.rematch.player1 && fresh.rematch.player2) {
    mySecretCache = {};
    lastFeedbackKey = null;
    renderResults._fired = false;
    await updateDoc(roomRef, {
      status: 'playing',
      currentRound: 1,
      round1: freshRound('player1', 'player2'),
      round2: freshRound('player2', 'player1'),
      overallWinner: null,
      rematch: { player1: false, player2: false },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Confetti (lightweight canvas implementation, no external lib)
// ---------------------------------------------------------------------
function launchConfetti() {
  const canvas = $('confetti-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const colors = ['#F2A65A', '#5AAFF2', '#F2C14E', '#EDEFF3'];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * window.innerWidth,
    y: -20 - Math.random() * window.innerHeight * 0.5,
    r: 4 + Math.random() * 5,
    vy: 2 + Math.random() * 3,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: -0.2 + Math.random() * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)],
    shape: Math.random() > 0.5 ? 'rect' : 'circle',
  }));

  let frame = 0;
  const maxFrames = 260;
  function tick() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      else { ctx.beginPath(); ctx.arc(0, 0, p.r / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    });
    frame++;
    if (frame < maxFrames) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------
$('btn-create-room').addEventListener('click', createRoom);

$('btn-show-join').addEventListener('click', () => {
  $('join-form').classList.toggle('hidden');
  if (!$('join-form').classList.contains('hidden')) $('join-code-input').focus();
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom($('join-code-input').value);
});
$('join-code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

$('btn-copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode || '');
    showToast('Room code copied.');
  } catch { showToast('Could not copy — copy it manually.'); }
});

$('btn-cancel-room').addEventListener('click', () => {
  resetToHome();
});

$('set-secret-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitSecret($('secret-input').value);
});
$('secret-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3);
});

$('guess-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitGuess($('guess-input').value);
});
$('guess-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3);
});

$('btn-play-again').addEventListener('click', playAgain);
$('btn-leave-room').addEventListener('click', resetToHome);

window.addEventListener('resize', () => {
  const canvas = $('confetti-canvas');
  if (canvas) { canvas.width = 0; canvas.height = 0; }
});
