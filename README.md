# Poky ♠♥♣♦

Texas Hold'em for you and your friends. Play chips only, no sign-up: pick a nickname and join.

- 2–9 players per table, private table codes and invite links
- Works on phones, tablets and desktops
- Fair dealing: cryptographically secure Fisher–Yates shuffle, fresh deck every hand, and only the server ever sees the deck
- Side pots, split pots, min-raise rules, turn timer, rebuys, sit out, reconnect after refresh
- Host controls: start, pause/resume, blinds, starting chips, turn timer, table style, remove players
- Four table styles (Classic Green, Burgundy Lounge, Midnight Blue, Kitchen Table). The wood grain, felt texture and lamp lighting are all drawn in CSS/SVG, with no image files
- Name your table ("Friday Night at Aryan's"): it's printed on the felt and shown in invite-link previews
- Chat with speech bubbles over each seat, quick one-tap phrases, and a hand log, all in one panel (bottom sheet on phones)
- Phrase suggestions pop up above your cards at big moments (big raises, all-ins, monster hands, big pots)
- **Master Dealer Pragy**, a mascot who sits beside the board and comments on the action (English + Hinglish)
- The pot slides to the winner, a banner calls out Full House or better, and a "Show my cards" button for bragging
- End-of-night recap: biggest pot, best hand, most hands won, standings and fun titles (Chip Leader, The Cowboy, The Rock…)

## Run it on your computer

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Friends on the same Wi-Fi can join using your computer's local IP,
e.g. `http://192.168.1.20:3000`.

## How to play

1. Enter a nickname, then **Create a new table**.
2. Tap the table code (top left) to copy the invite link and send it to friends.
3. When everyone is in, the host presses **Start game**. New hands deal automatically.

Keyboard shortcuts on desktop: **F** fold, **C** check/call, **R** raise (press again to confirm), **Esc** cancel.

## Tests

```bash
npm test
```

Covers hand rankings, betting rules (blinds, heads-up order, min-raises, incomplete all-ins,
side pots, odd chips), a randomized simulation of thousands of hands checking that no chips are
ever created or lost, an end-to-end multiplayer test, and statistical fairness checks:

- every card lands in every deck position equally often (chi-square, 100,000 shuffles)
- every seat wins, and gets pocket aces, equally often (20,000 full hands)
- a known-biased shuffle is detected, which shows the test can actually catch bias

## Deploy (Render, free tier)

1. Fork or use this repository.
2. On [render.com](https://render.com): **New → Web Service**, then pick the repo.
3. Settings: **Build command** `npm install`, **Start command** `npm start`, instance type **Free**.
4. Deploy, then share the `https://your-app.onrender.com` link.

Notes:
- The free tier sleeps after ~15 minutes of no traffic, so the first visit can take 30–60 seconds to wake up.
  A paid instance (or Railway / Fly.io) avoids that.
- Games live in memory. Restarting or redeploying the server ends any games in progress.
- Run a **single** instance. Don't scale to multiple servers, since tables live in one process's memory.

## Sounds

Card and chip sounds are real recordings from **"Casino Audio" by [Kenney](https://www.kenney.nl)**, released as CC0 (public domain).
See `public/sounds/LICENSE.txt`. They play for shuffling, dealing, folds, bets/calls, all-ins and the pot being pushed to the winner.
Checks are a soft double-knock, and your turn is a gentle chime. Turn sound on or off from the ☰ menu.

## Project layout

```
server.js         Express + Socket.IO server, room codes, input validation
src/cards.js      Deck and the secure shuffle
src/handEval.js   Hand ranking (best 5 of 7)
src/game.js       Game rules: blinds, betting, side pots, showdown, per-player views
src/room.js       Multiplayer: host, reconnects, turn timer, auto next hand, chat, end of night
src/pragy.js      Master Dealer Pragy: when he speaks and what he says
public/           The web client (plain HTML/CSS/JS, no build step)
public/phrases.js Quick chat phrases (happy / sad), easy to edit
test/             Tests
```
