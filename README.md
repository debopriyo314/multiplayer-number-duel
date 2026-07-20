# Duel — Two-Player Number Guessing Game

A live, two-player number-guessing duel. No backend server — Firebase
Firestore handles matchmaking and real-time sync, and Firebase Anonymous
Auth gives each player an identity so the security rules can hide the
secret number from their opponent.

Files:
- `index.html` — screens: home, room-waiting, game, results
- `style.css` — dark "combination lock" theme
- `app.js` — all game logic (auth, matchmaking, realtime sync, rendering, confetti)
- `firebase-config.js` — **you fill this in** with your Firebase project's config
- `firestore.rules` — security rules that actually enforce the "hide the secret" requirement

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com → **Add project** (the free
   Spark plan is enough).
2. Inside the project, click the **`</>` (Web) icon** to register a web
   app. You don't need Firebase Hosting for this step — just "register app".
3. Copy the `firebaseConfig` object it shows you.

## 2. Enable the services this game uses

- **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
  Anonymous auth is what lets each browser tab get a stable player ID
  without a login screen.
- **Build → Firestore Database → Create database.** Start in production
  mode (we ship real security rules below, so you don't need test mode).

## 3. Add your config

Open `firebase-config.js` and replace the placeholder values with the
config object from step 1:

```js
export const firebaseConfig = {
  apiKey: "…",
  authDomain: "….firebaseapp.com",
  projectId: "…",
  storageBucket: "….appspot.com",
  messagingSenderId: "…",
  appId: "…"
};
```

## 4. Deploy the security rules

This is the important part for the "no cheating" requirement — without
these rules, both browsers could technically read every field in
Firestore, including the opponent's secret number. The rules put each
round's secret number in a subcollection that only the player who set it
is ever allowed to read.

Easiest path, in the Firebase console:
**Build → Firestore Database → Rules** tab → paste the contents of
`firestore.rules` → **Publish**.

(Or, with the Firebase CLI: `firebase deploy --only firestore:rules`.)

## 5. Run it

This is a static site — no build step. Any static host works:

- **Quick local test:** from this folder, run `npx serve .` (or any
  static file server) and open the printed `localhost` URL in two
  browser tabs/devices.
- **Firebase Hosting (optional):** `firebase init hosting` (pick this
  folder as the public directory), then `firebase deploy`.
- Any other static host (Netlify, Vercel, GitHub Pages, etc.) also works
  — just make sure `firebase-config.js` ships with the real values.

Open the URL on two devices (or two browser tabs/profiles — anonymous
auth gives each *tab* its own identity, so two tabs in the same regular
browser window may share a session; use separate profiles or one normal
+ one incognito window for local testing).

## How the game works

- **Create Room** generates a random 6-digit code, creates a `rooms/{code}`
  document, and waits for a second player.
- **Join Room** looks up that document; once a second player's ID is
  attached, both clients flip to the game screen automatically via a
  live `onSnapshot` listener — no polling.
- **Round 1:** Player 1 sets a secret (masked input, 1–100). It's written
  to a `rooms/{code}/secrets/round1` document that only Player 1 can read
  back, per the security rules. Player 2 then guesses; each guess is
  written to the room doc as a `pendingGuess`. Player 1's own browser
  (which is the only one that can read the secret) resolves it — higher,
  lower, or correct — and writes the public result (feedback, guess log,
  narrowing range) back to the room doc for both screens to render.
- **Round 2:** roles swap automatically.
- **Winner:** once both rounds are done, guess counts are compared and
  the room is marked `finished` with an `overallWinner` field. The winner
  sees a confetti burst; a draw is called out explicitly.
- **Reconnects:** each client saves `{ roomCode, role }` to
  `localStorage`. On reload, it re-attaches to the same room and Firestore
  replays the current state — no progress is lost. A lightweight
  heartbeat (`lastSeen` timestamp, refreshed every 8s) shows a "may have
  disconnected" note if your opponent's tab goes quiet for 20+ seconds.
- **Play Again:** both players tap "Play Again"; once both have, the room
  resets to Round 1 with the same two players.

## Notes & limitations

- Firestore has no built-in presence system (that's a Realtime Database
  feature), so disconnect detection here is a best-effort heartbeat
  rather than instant push notification of a dropped connection.
- Room documents aren't automatically deleted after a game — for a
  personal/demo deployment that's fine; for anything long-running you'd
  want a scheduled Cloud Function (or a manual sweep) to clear old rooms,
  since the free Spark plan has generous but non-infinite Firestore storage.
