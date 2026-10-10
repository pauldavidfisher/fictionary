"""Fictionary Party: a Jackbox-style Fictionary game.

Any number of TVs (in any number of houses) open /tv and show the same room.
Every player joins on their own phone at /. The server holds all game state.
"""
import io
import os
import random
import secrets
import threading
import time

import segno
from flask import Flask, Response, abort, redirect, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

from words import WORDS

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY") or secrets.token_hex(16)
socketio = SocketIO(app, async_mode="threading", ping_interval=20, ping_timeout=40)

PUBLIC_URL = (os.environ.get("PUBLIC_URL") or "").rstrip("/")
FIRETV_APK_URL = os.environ.get("FIRETV_APK_URL") or \
    "https://github.com/pauldavidfisher/fictionary/releases/download/firetv-latest/fictionary-firetv.apk"
CODE_CHARS = "BCDFGHJKLMNPQRSTVWXZ"  # no vowels, so codes never spell words
MAX_PLAYERS = 10
MIN_PLAYERS = 3
# A room stays open while anyone is connected (up to a day without any moves),
# and closes 2 hours after the last phone or TV leaves.
ROOM_TTL = int(os.environ.get("ROOM_TTL", 24 * 3600))
EMPTY_TTL = int(os.environ.get("EMPTY_TTL", 2 * 3600))
SWEEP_EVERY = int(os.environ.get("SWEEP_EVERY", 300))
VIP_GRACE = int(os.environ.get("VIP_GRACE", 60))  # seconds the star waits for its owner to reconnect

LOCK = threading.RLock()
ROOMS = {}  # code -> Room
SIDS = {}   # socket id -> {"code", "kind": "tv"|"phone", "pid"}


def tidy(text):
    """Normalize a definition so formatting can't give away who wrote it."""
    t = " ".join((text or "").split()).rstrip(". ").strip()
    first = t.split(" ", 1)[0]
    if t and t[0].isupper() and first not in ("I", "I'm") and not (len(first) > 1 and first.isupper()):  # keep acronyms like "NASA"
        t = t[0].lower() + t[1:]
    return t[:160]


class Room:
    def __init__(self, code, base):
        self.code = code
        self.base = base
        self.players = []  # {"pid", "name", "score", "sid"}
        self.screens = set()
        self.vip = None
        self.host = None  # who the star belongs to (first to join)
        self.mode = "deck"
        self.rounds = 5
        self.used = set()
        self.touched = time.time()
        self.empty_since = None
        self.reset_game()

    # ---- helpers -------------------------------------------------------
    def reset_game(self):
        self.phase = "lobby"
        self.round = 0
        self.dasher_idx = -1
        self.dasher = None
        self.word = None
        self.entries = []      # {"author": pid or None (real), "text"}
        self.order = []        # shuffled entry indexes, as shown on screen
        self.participants = []
        self.votes = {}        # voter pid -> entry index
        self.seq = []          # reveal order (entry indexes)
        self.step = 0
        self.gains = {}
        self.dasher_bonus = False
        for p in self.players:
            p["score"] = 0

    def player(self, pid):
        return next((p for p in self.players if p["pid"] == pid), None)

    def name(self, pid):
        p = self.player(pid)
        return p["name"] if p else "Someone"

    def rekey(self, old, new):
        """Move a player's identity to a new device id everywhere it's referenced."""
        swap = lambda x: new if x == old else x
        self.player(old)["pid"] = new
        self.participants = [swap(x) for x in self.participants]
        self.votes = {swap(k): v for k, v in self.votes.items()}
        self.gains = {swap(k): v for k, v in self.gains.items()}
        for e in self.entries:
            e["author"] = swap(e["author"])
        self.vip, self.dasher, self.host = swap(self.vip), swap(self.dasher), swap(self.host)

    def connected(self):
        return [p for p in self.players if p["sid"]]

    def ensure_vip(self):
        """The host keeps the star through short drops and gets it back on return."""
        host = self.player(self.host)
        if host and (host["sid"] or time.time() - host.get("left_at", 0) < VIP_GRACE):
            self.vip = self.host
            return
        vip = self.player(self.vip)
        if not (vip and vip["sid"]):
            live = self.connected()
            if live:
                self.vip = live[0]["pid"]
            elif not vip:
                self.vip = self.players[0]["pid"] if self.players else None
        if not host:  # host left for good: the new star holder becomes host
            self.host = self.vip

    def writers(self):
        return [pid for pid in self.participants
                if self.player(pid) and not (self.mode == "dasher" and pid == self.dasher)]

    def submitted(self):
        return {e["author"] for e in self.entries if e["author"]}

    def pending(self):
        if self.phase == "write":
            done = self.submitted()
        elif self.phase == "vote":
            done = set(self.votes)
        else:
            return []
        return [pid for pid in self.writers() if pid not in done]

    def draw(self):
        pool = [w for w in WORDS if w[0] not in self.used]
        if not pool:
            self.used.clear()
            pool = WORDS
        w = random.choice(pool)
        self.used.add(w[0])
        return {"w": w[0], "pos": w[1], "d": w[2]}

    # ---- flow ----------------------------------------------------------
    def begin_write(self, word):
        self.word = word
        self.entries = [{"author": None, "text": word["d"]}]
        self.votes = {}
        self.phase = "write"

    def next_round(self):
        self.round += 1
        self.gains, self.step, self.seq = {}, 0, []
        self.entries, self.votes, self.dasher_bonus = [], {}, False
        if self.round > self.rounds:
            self.phase = "final"
            return
        self.participants = [p["pid"] for p in self.connected()]
        if self.mode == "dasher":
            n = len(self.players)
            for _ in range(n):
                self.dasher_idx = (self.dasher_idx + 1) % n
                if self.players[self.dasher_idx]["sid"]:
                    break
            self.dasher = self.players[self.dasher_idx]["pid"]
            self.word = None
            self.phase = "dasher"
        else:
            self.dasher = None
            self.begin_write(self.draw())

    def maybe_advance(self):
        if self.phase == "write" and not self.pending():
            self.to_board()
        elif self.phase == "vote" and not self.pending():
            self.to_reveal()

    def to_board(self):
        self.order = list(range(len(self.entries)))
        random.shuffle(self.order)
        self.phase = "board"

    def to_reveal(self):
        def votes_for(i):
            return sum(1 for v in self.votes.values() if v == i)
        fakes = sorted((i for i in self.order if self.entries[i]["author"]), key=votes_for)
        real = [i for i in self.order if not self.entries[i]["author"]]
        self.seq, self.step = fakes + real, 0
        gains, found = {}, False
        for voter, i in self.votes.items():
            author = self.entries[i]["author"]
            if author is None:
                gains[voter] = gains.get(voter, 0) + 2
                found = True
            else:
                gains[author] = gains.get(author, 0) + 1
        if self.mode == "dasher" and not found and self.dasher:
            gains[self.dasher] = gains.get(self.dasher, 0) + 3
            self.dasher_bonus = True
        for pid, g in gains.items():
            p = self.player(pid)
            if p:
                p["score"] += g
        self.gains = gains
        self.phase = "reveal"

    # ---- views ---------------------------------------------------------
    def public(self):
        done = self.phase == "reveal" and self.step >= len(self.seq)
        pend = set(self.pending())
        players = []
        for p in self.players:
            g = self.gains.get(p["pid"], 0) if self.phase == "reveal" else 0
            players.append({
                "pid": p["pid"], "name": p["name"],
                "score": p["score"] if (done or self.phase != "reveal") else p["score"] - g,
                "gain": g if done else 0,
                "connected": bool(p["sid"]),
                "vip": p["pid"] == self.vip,
                "dasher": p["pid"] == self.dasher,
                "waiting": p["pid"] in pend,
                "playing": p["pid"] in self.participants,
            })
        v = {
            "code": self.code, "phase": self.phase, "round": self.round,
            "rounds": self.rounds, "mode": self.mode, "players": players,
            "screens": len(self.screens), "minPlayers": MIN_PLAYERS,
            "joinUrl": f"{self.base}/?r={self.code}", "tvUrl": f"{self.base}/tv",
            "host": self.base.split("://", 1)[-1],
            "vipName": self.name(self.vip) if self.vip else None,
            "dasherName": self.name(self.dasher) if self.dasher else None,
        }
        if self.word and self.phase in ("write", "board", "vote", "reveal"):
            v["word"] = {"w": self.word["w"], "pos": self.word["pos"]}
        if self.phase in ("board", "vote", "reveal"):
            v["defs"] = [self.entries[i]["text"] for i in self.order]
        if self.phase == "write":
            v["fakes"] = len(self.entries) - 1
        if self.phase == "vote":
            v["voted"] = len(self.votes)
        if self.phase == "reveal":
            shown = set(self.seq[:self.step])
            cards = []
            for i in self.order:
                if i not in shown:
                    cards.append(None)
                    continue
                e = self.entries[i]
                cards.append({
                    "real": e["author"] is None,
                    "by": self.name(e["author"]) if e["author"] else None,
                    "voters": [self.name(pid) for pid, vi in self.votes.items() if vi == i],
                })
            v.update(cards=cards, step=self.step, steps=len(self.seq),
                     done=done, dasherBonus=self.dasher_bonus and done)
        return v

    def private(self, p):
        v = self.public()
        pid = p["pid"]
        mine = next((i for i, e in enumerate(self.entries) if e["author"] == pid), None)
        me = {
            "pid": pid, "name": p["name"], "vip": pid == self.vip,
            "dasher": pid == self.dasher,
            "playing": pid in self.participants,
            "writer": pid in self.writers(),
            "myText": self.entries[mine]["text"] if mine is not None else None,
            "mine": self.order.index(mine) if (mine is not None and mine in self.order) else None,
            "voted": self.order.index(self.votes[pid]) if pid in self.votes and self.votes[pid] in self.order else None,
        }
        if pid == self.dasher and self.word:
            me["real"] = self.word["d"]
        v["me"] = me
        return v


# ---- plumbing -----------------------------------------------------------

def broadcast(room):
    room.touched = time.time()
    socketio.emit("state", room.public(), to=f"tv:{room.code}")
    for p in room.players:
        if p["sid"]:
            socketio.emit("state", room.private(p), to=p["sid"])


def fail(msg):
    emit("err", {"msg": msg})


def new_code():
    while True:
        code = "".join(random.choice(CODE_CHARS) for _ in range(4))
        if code not in ROOMS:
            return code


def current():
    """Return (room, player) for this socket, either may be None."""
    info = SIDS.get(request.sid)
    if not info:
        return None, None
    room = ROOMS.get(info["code"])
    if not room:
        return None, None
    return room, room.player(info.get("pid")) if info["kind"] == "phone" else None


def as_vip():
    room, p = current()
    if not room or not p:
        fail("Join a game first.")
        return None, None
    if room.vip != p["pid"]:
        fail(f"Only {room.name(room.vip)} can do that.")
        return None, None
    return room, p


def detach(sid):
    info = SIDS.pop(sid, None)
    if not info:
        return
    room = ROOMS.get(info["code"])
    if not room:
        return
    if info["kind"] == "tv":
        room.screens.discard(sid)
        leave_room(f"tv:{room.code}", sid=sid)
    else:
        p = room.player(info["pid"])
        if p and p["sid"] == sid:
            p["sid"] = None
            p["left_at"] = time.time()
            socketio.start_background_task(recheck_vip, room.code)
        room.ensure_vip()
    broadcast(room)


def recheck_vip(code):
    """After the grace period, pass the star on if its owner hasn't come back."""
    socketio.sleep(VIP_GRACE + 1)
    with LOCK:
        room = ROOMS.get(code)
        if room:
            before = room.vip
            room.ensure_vip()
            if room.vip != before:
                broadcast(room)


def attach_phone(room, name, pid):
    name = " ".join((name or "").split())[:16]
    if not name:
        return fail("Enter your name.")
    pid = str(pid or "")[:64] or secrets.token_hex(8)
    p = room.player(pid)
    if not p:
        same = next((x for x in room.players if x["name"].casefold() == name.casefold()), None)
        if same and same["sid"]:
            return fail(f"Someone called {same['name']} is already in this game. Pick another name.")
        if same:  # rejoining from a new browser: take back the old seat, score and round
            room.rekey(same["pid"], pid)
            p = same
        else:
            if len(room.players) >= MAX_PLAYERS:
                return fail(f"This game is full ({MAX_PLAYERS} players).")
            p = {"pid": pid, "name": name, "score": 0, "sid": None}
            room.players.append(p)
    old = p["sid"]
    if old and old != request.sid:
        SIDS.pop(old, None)
        socketio.emit("kicked", {"msg": "You opened this game somewhere else."}, to=old)
    p["sid"] = request.sid
    SIDS[request.sid] = {"code": room.code, "kind": "phone", "pid": p["pid"]}
    room.ensure_vip()
    emit("joined", {"code": room.code, "pid": p["pid"], "name": p["name"]})
    broadcast(room)


def base_url(data):
    if PUBLIC_URL:
        return PUBLIC_URL
    b = str((data or {}).get("base") or "").rstrip("/")
    return b if b.startswith(("http://", "https://")) else request.host_url.rstrip("/")


# ---- routes -------------------------------------------------------------

SITE_TITLE = "Fictionary Party: the bluffing dictionary game"
SITE_DESC = ("Write fake definitions for obscure words, fool your friends and find the real one. "
             "Everyone plays on their phone, and every house can put the game on its own TV.")


def site_base():
    """The public https address, even behind Render's proxy."""
    if PUBLIC_URL:
        return PUBLIC_URL
    proto = request.headers.get("X-Forwarded-Proto", request.scheme).split(",")[0].strip()
    return f"{proto}://{request.host}"


def page_meta(path, title=SITE_TITLE, description=SITE_DESC):
    base = site_base()
    return {
        "base": base, "url": base + path, "title": title, "description": description,
        "jsonld": {
            "@context": "https://schema.org", "@type": "WebApplication",
            "name": "Fictionary Party", "url": base + "/", "image": base + "/static/img/share.jpg",
            "description": SITE_DESC, "applicationCategory": "GameApplication",
            "operatingSystem": "Any (web browser), Fire TV", "inLanguage": "en",
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        },
    }


@app.route("/")
def phone():
    code = "".join(c for c in (request.args.get("r") or "").upper() if c.isalpha())[:4]
    if len(code) == 4:  # a shared invite link previews as an invite to that game
        meta = page_meta(f"/?r={code}", title=f"Join my Fictionary game · Room {code}",
                         description=f"Tap to join room {code} on your phone. Fictionary is the bluffing "
                                     "dictionary game: write fake definitions, fool your friends, find the real one.")
    else:
        meta = page_meta("/")
    return render_template("phone.html", meta=meta)


@app.route("/tv")
def tv():
    return render_template("tv.html", meta=page_meta("/tv", title="Fictionary Party · TV screen",
        description="Put Fictionary on the big screen. Host a game or show one already running; "
                    "everyone plays on their phone, from any house."))


@app.route("/favicon.ico")
def favicon():
    return app.send_static_file("img/favicon.ico")


@app.route("/apple-touch-icon.png")
@app.route("/apple-touch-icon-precomposed.png")
def apple_icon():
    return app.send_static_file("img/apple-touch-icon.png")


@app.route("/manifest.webmanifest")
def manifest():
    return {
        "name": "Fictionary Party", "short_name": "Fictionary",
        "description": SITE_DESC, "start_url": "/", "scope": "/", "display": "standalone",
        "background_color": "#1c2a6b", "theme_color": "#1c2a6b",
        "icons": [
            {"src": "/static/img/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": "/static/img/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    }, 200, {"Content-Type": "application/manifest+json"}


@app.route("/robots.txt")
def robots():
    return Response(f"User-agent: *\nAllow: /\nDisallow: /qr/\n\nSitemap: {site_base()}/sitemap.xml\n",
                    mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap():
    b = site_base()
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
           f"<url><loc>{b}/</loc></url><url><loc>{b}/tv</loc></url></urlset>")
    return Response(xml, mimetype="application/xml")


@app.route("/qr/<code>.svg")
def qr(code):
    room = ROOMS.get(code.upper())
    if not room:
        abort(404)
    buf = io.BytesIO()
    segno.make(f"{room.base}/?r={room.code}", error="m").save(
        buf, kind="svg", scale=10, border=2, dark="#1b1d2e", light="#fbfaf5")
    return Response(buf.getvalue(), mimetype="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.route("/app")
def firetv_app():
    """Short address for installing the Fire TV app with the Downloader app."""
    return redirect(FIRETV_APK_URL, code=302)


@app.route("/health")
def health():
    return {"ok": True, "rooms": len(ROOMS)}


# ---- socket events --------------------------------------------------------

@socketio.on("create")
def on_create(data):
    data = data or {}
    with LOCK:
        detach(request.sid)
        room = Room(new_code(), base_url(data))
        ROOMS[room.code] = room
        if data.get("kind") == "tv":
            room.screens.add(request.sid)
            SIDS[request.sid] = {"code": room.code, "kind": "tv", "pid": None}
            join_room(f"tv:{room.code}")
            emit("joined", {"code": room.code})
            broadcast(room)
        else:
            attach_phone(room, data.get("name"), data.get("pid"))
            if not room.players:
                ROOMS.pop(room.code, None)


@socketio.on("join_tv")
def on_join_tv(data):
    code = str((data or {}).get("code") or "").strip().upper()
    with LOCK:
        room = ROOMS.get(code)
        if not room:
            return emit("err", {"msg": f"No game with code {code or '(blank)'}. Check the code on the other screen.", "noRoom": True})
        detach(request.sid)
        room.screens.add(request.sid)
        SIDS[request.sid] = {"code": code, "kind": "tv", "pid": None}
        join_room(f"tv:{code}")
        emit("joined", {"code": code})
        broadcast(room)


@socketio.on("join")
def on_join(data):
    data = data or {}
    code = str(data.get("code") or "").strip().upper()
    with LOCK:
        room = ROOMS.get(code)
        if not room:
            return emit("err", {"msg": f"No game with code {code or '(blank)'}. Check the code on the TV.", "noRoom": True})
        info = SIDS.get(request.sid)
        if info and info["code"] != code:
            detach(request.sid)
        attach_phone(room, data.get("name"), data.get("pid"))


@socketio.on("leave")
def on_leave():
    with LOCK:
        room, p = current()
        SIDS.pop(request.sid, None)
        if room and p:
            p["sid"] = None
            if room.host == p["pid"]:
                room.host = None  # leaving on purpose hands the star on right away
            if room.phase == "lobby" or room.phase == "final":
                room.players.remove(p)
            elif p["pid"] in room.participants:
                room.participants.remove(p["pid"])
                room.maybe_advance()
            room.ensure_vip()
            broadcast(room)
        emit("left")


@socketio.on("disconnect")
def on_disconnect(*_):
    with LOCK:
        detach(request.sid)


@socketio.on("settings")
def on_settings(data):
    with LOCK:
        room, _ = as_vip()
        if not room or room.phase != "lobby":
            return
        if data.get("mode") in ("deck", "dasher"):
            room.mode = data["mode"]
        if data.get("rounds") in (3, 5, 7, 10):
            room.rounds = data["rounds"]
        broadcast(room)


@socketio.on("start")
def on_start():
    with LOCK:
        room, _ = as_vip()
        if not room or room.phase not in ("lobby", "final"):
            return
        if len(room.connected()) < MIN_PLAYERS:
            return fail(f"You need at least {MIN_PLAYERS} players on their phones.")
        room.players = [p for p in room.players if p["sid"]]
        room.reset_game()
        room.next_round()
        broadcast(room)


@socketio.on("to_lobby")
def on_to_lobby():
    with LOCK:
        room, _ = as_vip()
        if room and room.phase == "final":
            room.reset_game()
            broadcast(room)


@socketio.on("dasher_deck")
def on_dasher_deck():
    with LOCK:
        room, p = current()
        if room and p and room.phase == "dasher" and p["pid"] == room.dasher:
            emit("deck_word", room.draw())


@socketio.on("dasher_word")
def on_dasher_word(data):
    with LOCK:
        room, p = current()
        if not room or not p or room.phase != "dasher" or p["pid"] != room.dasher:
            return
        w = " ".join(str(data.get("w") or "").split())[:30]
        pos = data.get("pos") if data.get("pos") in ("n.", "v.", "adj.", "adv.", "interj.") else "n."
        d = tidy(data.get("d"))
        if not w or len(d) < 4:
            return fail("Enter both the word and its real definition.")
        room.begin_write({"w": w, "pos": pos, "d": d})
        broadcast(room)


@socketio.on("new_word")
def on_new_word():
    """Someone already knows the word: swap it."""
    with LOCK:
        room, _ = as_vip()
        if not room or room.phase != "write":
            return
        if room.mode == "dasher":
            room.word, room.entries, room.phase = None, [], "dasher"
        else:
            room.begin_write(room.draw())
        broadcast(room)


@socketio.on("submit")
def on_submit(data):
    with LOCK:
        room, p = current()
        if not room or not p or room.phase != "write" or p["pid"] not in room.writers():
            return
        t = tidy((data or {}).get("text"))
        if len(t) < 4:
            return fail("Write a definition first.")
        if t.casefold() == room.word["d"].casefold():
            return fail("That's the real definition. Write a fake one.")
        if any(e["text"].casefold() == t.casefold() and e["author"] != p["pid"] for e in room.entries):
            return fail("Someone already wrote that exact definition. Change a few words.")
        mine = next((e for e in room.entries if e["author"] == p["pid"]), None)
        if mine:
            mine["text"] = t
        else:
            room.entries.append({"author": p["pid"], "text": t})
        room.maybe_advance()
        broadcast(room)


@socketio.on("force")
def on_force():
    """VIP moves on without waiting for missing players."""
    with LOCK:
        room, _ = as_vip()
        if not room:
            return
        if room.phase == "dasher":
            room.begin_write(room.draw())
        elif room.phase == "write":
            if len(room.entries) < 2:
                return fail("Wait for at least one fake definition.")
            room.to_board()
        elif room.phase == "vote":
            room.to_reveal()
        broadcast(room)


@socketio.on("start_vote")
def on_start_vote():
    with LOCK:
        room, _ = as_vip()
        if room and room.phase == "board":
            room.votes, room.phase = {}, "vote"
            broadcast(room)


@socketio.on("vote")
def on_vote(data):
    with LOCK:
        room, p = current()
        if not room or not p or room.phase != "vote" or p["pid"] not in room.writers():
            return
        if p["pid"] in room.votes:
            return fail("Your vote is already in.")
        try:
            i = room.order[int((data or {}).get("k"))]
        except (TypeError, ValueError, IndexError):
            return
        if room.entries[i]["author"] == p["pid"]:
            return fail("You can't vote for your own definition.")
        room.votes[p["pid"]] = i
        room.maybe_advance()
        broadcast(room)


@socketio.on("reveal")
def on_reveal():
    with LOCK:
        room, _ = as_vip()
        if room and room.phase == "reveal" and room.step < len(room.seq):
            room.step += 1
            broadcast(room)


@socketio.on("next")
def on_next():
    with LOCK:
        room, _ = as_vip()
        if room and room.phase == "reveal" and room.step >= len(room.seq):
            room.next_round()
            broadcast(room)


@socketio.on("remove")
def on_remove(data):
    with LOCK:
        room, vip = as_vip()
        if not room:
            return
        p = room.player((data or {}).get("pid"))
        if not p or p is vip:
            return
        if p["sid"]:
            if room.phase != "lobby":
                return fail(f"{p['name']} is still connected.")
            SIDS.pop(p["sid"], None)
            socketio.emit("kicked", {"msg": "You were removed from the game."}, to=p["sid"])
        room.players.remove(p)
        if p["pid"] in room.participants:
            room.participants.remove(p["pid"])
            room.maybe_advance()
        room.ensure_vip()
        broadcast(room)


def sweeper():
    """Close rooms nobody is using, and tell any screen still showing one."""
    while True:
        socketio.sleep(SWEEP_EVERY)
        with LOCK:
            now = time.time()
            for code, room in list(ROOMS.items()):
                anyone = room.screens or room.connected()
                if anyone:
                    room.empty_since = None
                elif room.empty_since is None:
                    room.empty_since = now
                abandoned = room.empty_since is not None and now - room.empty_since > EMPTY_TTL
                if abandoned or now - room.touched > ROOM_TTL:
                    ROOMS.pop(code, None)
                    for sid, info in list(SIDS.items()):
                        if info["code"] == code:
                            SIDS.pop(sid, None)
                            socketio.emit("ended", {"msg": f"Game {code} has ended. Start a new one to keep playing."}, to=sid)


socketio.start_background_task(sweeper)

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)),
                 debug=False, allow_unsafe_werkzeug=True)
