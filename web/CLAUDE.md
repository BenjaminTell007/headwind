# Headway frontend: rules for every Claude working in web/

Two of us work on the frontend, each with our own Claude. Our Claudes can't message each other directly, so they talk through this repo. Follow this file exactly.

## 1. Talk to the other Claude through web/team/

Each person has one note: `web/team/<name>.md`, where `<name>` is your branch name without `'s-branch` (kimball's-branch → `kimball.md`).

- **Only ever edit your own note.** Never edit someone else's. That way the notes can never conflict.
- **Read the others' notes** with `web/tools/team.sh`. It fetches every branch from GitHub and prints everyone's newest note, so you don't need to merge anything to read them.
- **When to read:** at the start of every session, before you start any new piece of work, and before you touch a file you haven't touched yet this session.
- **When to write:** when you start something, finish something, or need something from the other person. Commit and push your note right away (own branch), so they see it within a minute.
- If the other Claude asked you something under **Asks**, answer it in **Replies** in your own note, and tell your human about it.
- Keep your note short. Replace stale lines instead of piling up history; git keeps the history.

If you don't have a note yet, create it with this template:

```markdown
# <name>

## Working on now
- (what, which files)

## Files I'm editing (don't touch without asking)
- web/js/...

## Done recently
- (newest first, one line each, with commit or date)

## Asks (for the other Claude)
- → <their name>: (question or request)

## Replies
- ← <their name>: (answer to their ask)
```

## 2. Git: pull and push constantly

- Work on your own branch (`<name>'s-branch`). Never commit straight onto `frontend` or `main`.
- Pull before every edit: `git pull --rebase origin <your-branch>`, and pull `frontend` into your branch often (`git pull origin frontend`) so you have the other person's merged work.
- Commit and push after every small finished piece. Never one big commit at the end. Never force-push.
- Flow: your branch → `frontend` (merge when a piece works) → `main` (only when the human says so). The site is GitHub Pages from `main`: https://kimballw1.github.io/Headway/
- Before merging into `frontend`, pull it, run the page, and check the console is clean.
- Never commit `PRIVATE.md` or any key.

## 3. Scope

Frontend only: `web/` and `design/`. Don't edit `server/`, `contracts/`, `scripts/`, `requirements.txt`, `railway.json` or the data pipeline. If the frontend needs a backend change, write it in your note under Asks and tell your human. `web/chain/` is Xavi's wallet and contract code: use it, don't rewrite it.

## 4. How the page is built

Plain HTML, CSS and JS, no build step. Run it from the repo root with `python3 -m http.server 8000` and open http://localhost:8000/web/ (add `?local` to use a server on port 8787 instead of Railway).

| File | What it is |
|---|---|
| `js/util.js` | palette (`HW.C`), formatting, canvas stage, sparkline |
| `js/data.js` | loads `data/processed/`, live ships, markets, weather (Open-Meteo) |
| `js/logo.js` | glyph-matrix HEADWAY logo |
| `js/globe.js` | the globe: routes, flow particles, strait valves, live ships |
| `js/ship.js` | the ship dive scene: drone and profile views, weather |
| `js/main.js` | wires it all: overview, markets rail, panel, timeline, search, dive |
| `app.css` | all styles |

Split work by file where you can. Two people editing `main.js` or `app.css` at the same time is where conflicts come from, so claim them in your note first.

## 5. Look and feel (don't break these)

- Colour only ever means vessel type: container `#f08a3c`, tanker `#8f82f2`, dry bulk `#46b36f`, general cargo `#ea86b5`, ro-ro `#e9c84b`, other `#f2f2f2`. Efficiency, odds and drops use brightness, thickness, opacity or length, never hue.
- Background `#222222`, land `#3a3a3a`, text `#ececec`, dim `#8c8c8c`. YES `#f2f2f2`, NO `#6b6b6b`.
- Labels: light monospace, caps, wide letter spacing. Numbers: the sans stack.
- Full rules: the Look and feel section of `BRIEF.md`.
