# Fictionary Party

The bluffing dictionary game, played Jackbox-style. Everyone plays on their own phone, and any number of TVs, in any number of houses, show the same game.

- **Phones:** `https://YOUR-SITE/` to join with a 4-letter room code (or scan the QR code on the TV)
- **TVs:** `https://YOUR-SITE/tv` to host a new game or show one that's already running

## How a game works

1. One TV opens `/tv` and picks **Host a new game**. It shows a room code and a QR code.
   (Or someone taps **Start a new game** on their phone. A TV isn't required.)
2. Players join on their phones from anywhere. The first player to join gets a ★ and **runs the game** (the VIP), so have the person running the game night join first. If their phone drops, the ★ waits a minute for them; after that it passes to another player and comes back when they return. The VIP picks the word mode and rounds, then starts.
3. **Other houses:** open `/tv` on that house's TV, choose "Show a game that's already running", and enter the same code. Every TV stays in sync. If you're on a video call, one person reads the definitions aloud.
4. Each round: everyone writes a fake definition on their phone → the TVs list all of them, shuffled with the real one → everyone votes privately → the VIP reveals the bluffs one by one, with the real definition last.

**Scoring** (same as the prototype): 2 points for picking the real definition, 1 point for every player your bluff fools. In *Dasher picks* mode, the dasher scores 3 if nobody finds the real one.

**VIP controls on the phone:** start the game, "Someone knows this word" (swaps it), continue without a player who's gone quiet, open voting, reveal next, next round, play again, and remove a disconnected player.

**Dropped phones:** if a phone locks or loses signal, reopen the page and it rejoins automatically with the same score. On a different phone, joining with the same name takes the old seat back.

## Run it locally

```bash
cd ~/Downloads/local-repos/fictionary-3
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000/tv on the computer. Phones on the same Wi-Fi can join at `http://YOUR-COMPUTER-IP:5000`.

## Deploy to Render

1. Push this folder to a new GitHub repo (e.g. `pauldavidfisher/fictionary`).
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` sets everything up.
3. Optional: add a custom domain like `fictionary.plumdesignbuild.com` and set `PUBLIC_URL` to it. This keeps the QR code and join links using your domain.

Notes:
- The service must run **one** worker (it's already set). Games live in memory, so a redeploy or restart ends any game in progress. Deploy when nobody's playing.
- On the free plan, the first visit after a quiet spell takes 30 to 60 seconds to wake up. The Starter plan stays awake.
- A game stays open as long as someone has it open (up to a day with no moves) and closes 2 hours after everyone leaves. Any screen still showing a closed game says so.

## Fire TV app

The `firetv/` folder is a small Android app that opens the game's TV screen full-screen on a Fire TV. It keeps the screen awake, works with the remote, and shows a "Try again" screen if the internet drops. Phones still play in their browser.

**How it gets built:** you don't need Android Studio. Every push that changes `firetv/` makes GitHub build the app (see the **Actions** tab, about 4 minutes) and publish it as the release **Fire TV app (latest)**. You can also start a build by hand: Actions → Build Fire TV app → Run workflow.

**Installing on a Fire TV** (once per TV):
1. Turn on developer options: Settings → My Fire TV → About → highlight the device name and press the select button 7 times.
2. From the Fire TV app store, install **Downloader** (by AFTVnews).
3. Settings → My Fire TV → Developer options → Install unknown apps → turn on **Downloader**.
4. Open Downloader and enter `fictionary-d6b2.onrender.com/app`, then choose **Install**, then **Open**.
5. Fictionary now appears in Your Apps & Channels. Hold the select button on it to move it to the front row.

New builds install the same way and update the existing app.

**The repo must be public** for the Fire TV to download the app (GitHub won't serve release files from a private repo without a login). The game code isn't secret, but if you'd rather keep the repo private, download `fictionary-firetv.apk` from the release on your Mac and host it somewhere public, then set `FIRETV_APK_URL` in Render to that address.

**Other details:**
- The game address the app opens is in `firetv/app/src/main/res/values/strings.xml`. Change it there if you move to a custom domain.
- The ☰ button on the remote reloads the game. Back leaves the app.
- `firetv/fictionary.keystore` signs every build with the same key so updates install over the old app. It's only for your own TVs; the Amazon Appstore re-signs apps with its own key.
- `firetv/store-assets/` has the icon and banner art in the sizes the Amazon Appstore asks for, if you publish it there later.

## Adding words

Edit `words.py`: each row is `("word", "part of speech", "real definition")`. Write definitions in lowercase dictionary style with no ending period, to match how players' bluffs are formatted.

## Files

| File | What it does |
|---|---|
| `app.py` | Server: rooms, game rules, scoring, real-time updates |
| `words.py` | The word deck |
| `templates/tv.html`, `static/tv.js` | The TV screen |
| `templates/phone.html`, `static/phone.js` | The phone controller |
| `static/common.js`, `static/style.css` | Shared pieces and styling |
| `static/socket.io.min.js` | Real-time client library (bundled so it works without outside servers) |
