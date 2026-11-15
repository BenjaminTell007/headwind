# Running the server on Railway

This moves the server and the ship logger off my laptop onto Railway, so they keep running when the laptop is closed. Railway builds straight from the GitHub repo.

Railway's buttons and tab names change now and then, so if a name here doesn't match exactly, look for the closest thing.

## What the repo already does

Nothing to change in the code. These files tell Railway what to do:

- `railway.json`: the start command (`python -m uvicorn server.app:app --host 0.0.0.0 --port $PORT`), the health check (`/api/health`) and "always restart"
- `requirements.txt`: the four packages the server and logger need
- `.python-version`: Python 3.13

With `RUN_LOGGER=1` set, the server starts the ship logger itself and restarts it if it ever stops.

## 1. Account and project

1. Go to railway.com and sign in with GitHub.
2. Click **New Project**, then **Deploy from GitHub repo**.
3. If `kimballw1/Headway` isn't in the list, click **Configure GitHub App** and give Railway access to that repo, then come back and pick it.
4. Railway creates a service called Headway and starts a first build. That first build may fail or run without ships because the variables aren't set yet. That's fine.

## 2. Variables

1. Click the **Headway** service box, then the **Variables** tab.
2. Add these three (or click **Raw Editor** and paste them in, one per line):

```
AISSTREAM_API_KEY=the key from PRIVATE.md
RUN_LOGGER=1
HEADWAY_RETAIN_DAYS=1
```

3. Check the spelling exactly. `RUN_LOGGER` has to be `1`, not `true`.
4. Railway shows a banner saying there are changes to apply. Click **Deploy** (or **Apply changes**) on it. Variables only take effect after a deploy.

Don't add `PORT`. Railway sets it.

## 3. Watch the build and start

1. Open the **Deployments** tab. The newest deployment goes **Initializing**, **Building**, **Deploying**, then **Active** (green). Usually 2 to 4 minutes.
2. Click that deployment and open **Deploy Logs** (not Build Logs).
3. A healthy start shows these lines, roughly in this order:

```
Uvicorn running on http://0.0.0.0:8080
starting ship logger
HH:MM:SS connected and subscribed
HH:MM:SS {'position': 2471, 'gate': 376, 'sample': 2416, 'static': 845}
```

The last line repeats every minute and the numbers should keep going up.

## 4. Public address

1. In the service, open **Settings**, scroll to **Networking**.
2. Click **Generate Domain**.
3. If it asks which port, use the one from the `Uvicorn running on` log line (usually `8080`).
4. You get a URL like `headway-production-xxxx.up.railway.app`. That's the server's permanent address.

## 5. Check it works

Open each of these with your Railway URL in front:

| Link | What you should see |
|---|---|
| `/` | Dark HEADWAY status page, "SERVER: RUNNING", ship count climbing |
| `/api/health` | `ships_in_memory` above a few hundred after a minute, three files in `logger_files` |
| `/api/ships?types=cargo,tanker&moving_only=true&limit=5` | Five ships with names, positions and destinations |
| `/api/gates/singapore/count?minutes=30` | A count (it's 0 until the server has run for a while) |
| `/data/overview.json` | The overview numbers |

Ship counts start at zero on every deploy and build up: a few thousand after 5 minutes, close to 20,000 after an hour.

## 6. Switch everyone over

1. Send the URL to Claude (or edit these yourself): `SHARED_SERVER` at the top of the script in `web/index.html`, the "Shared server" section of `PRIVATE.md`, and the "Running it" section of `PLAN.md`.
2. Tell the team the new URL. No tunnel password and no `bypass-tunnel-reminder` header needed with Railway.
3. Once the Railway URL works, the laptop pieces can stop: close the tunnel terminal, and stop the laptop logger with `kill $(cat ~/Downloads/Chokepoint/data/live/logger.pid)`. Keep the laptop logger running until Railway is confirmed, though.

## 7. Things to know during the day

- **Every push to `main` redeploys.** A redeploy restarts the server with no ship history, which breaks any live market that's open. About an hour before the demo, turn off automatic deploys (in the service **Settings**, under **Source**, there's an option for automatic deploys on push) or just stop pushing server changes.
- **Keep ship history across deploys (optional).** In the service, add a **Volume** with mount path `/live`, then add the variable `HEADWAY_LIVE_DIR=/live` and redeploy. The logs then survive restarts.
- **Cost.** The **Usage** page in your account shows what's been spent. This server is small, so it should stay within the trial credit or a few dollars.
- **Restarting by hand.** In **Deployments**, the three-dot menu on the active deployment has **Restart** and **Redeploy**.

## If something's wrong

| What you see | Cause | Fix |
|---|---|---|
| `RUN_LOGGER=1 but AISSTREAM_API_KEY is not set` | Key variable missing or misspelled | Fix it in Variables, apply, redeploy |
| No `starting ship logger` line | `RUN_LOGGER` isn't exactly `1` | Fix it, redeploy |
| `connection dropped`, then `connected and subscribed` | Normal: aisstream drops connections now and then | Nothing, it reconnects by itself |
| `Healthcheck failed` | Server didn't start in time | Open Deploy Logs, look for a Python error, send it to Claude |
| Build fails at installing packages | Wrong Python or a package problem | Check `.python-version` says 3.13, send the Build Logs |
| Status page loads but 0 ships after 5 minutes | Logger isn't connecting | Check Deploy Logs for logger errors; make sure the key has no extra spaces |
| "Application failed to respond" on the URL | Domain points at the wrong port | In Networking, set the port to the one in the `Uvicorn running on` line |
