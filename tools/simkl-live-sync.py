import calendar
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

SIMKL_UID = "8094166"
DASHBOARD_URL = f"https://simkl.com/{SIMKL_UID}/dashboard/"
HUB_API_URL = "https://uwaazy.vercel.app/api/simkl"
LOCAL_PORT = 18095
NUVIO_DIR = os.path.join(os.environ.get("APPDATA", ""), "Nuvio")
NUVIO_PROGRESS_PATH = os.path.join(NUVIO_DIR, "nuvio_watch_progress.properties")
NUVIO_SIMKL_PATH = os.path.join(NUVIO_DIR, "nuvio_simkl_sync.properties")
NUVIO_TMDB_PATH = os.path.join(NUVIO_DIR, "nuvio_tmdb_settings.properties")
ROOT_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


def load_local_env():
    vals = {}
    try:
        if os.path.isfile(ROOT_ENV_PATH):
            for line in open(ROOT_ENV_PATH, encoding="utf-8", errors="ignore"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    vals[k.strip()] = v.strip().strip("\"'")
    except Exception:
        pass
    try:
        if not vals.get("TMDB_API_KEY") and os.path.isfile(NUVIO_TMDB_PATH):
            raw = open(NUVIO_TMDB_PATH, encoding="utf-8", errors="ignore").read()
            m = re.search(r"^tmdb_api_key_2=(.+)$", raw, flags=re.M)
            if m:
                vals["TMDB_API_KEY"] = m.group(1).strip()
    except Exception:
        pass
    try:
        if not vals.get("HUB_SECRET"):
            playnite_cfg = os.path.join(os.environ.get("APPDATA", ""), "Playnite", "config.json")
            if os.path.isfile(playnite_cfg):
                raw = open(playnite_cfg, encoding="utf-8", errors="ignore").read()
                m = re.search(r"(?:\$secret\s*=|Bearer)\s*['\"]?([A-Za-z0-9._-]{16,})", raw)
                if m:
                    vals["HUB_SECRET"] = m.group(1).strip()
    except Exception:
        pass
    return vals


_ENV = load_local_env()
HUB_SECRET = os.environ.get("HUB_SECRET") or _ENV.get("HUB_SECRET") or ""
TMDB_KEY = os.environ.get("TMDB_API_KEY") or _ENV.get("TMDB_API_KEY") or ""

LAST_PATH = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.dirname(os.path.abspath(__file__)), "uwaazy-last-watched.json")
STATE = {"live": False, "item": None, "updatedAt": 0}
I18N_CACHE = {}
IMDB_MAP = {}
SIMKL_MAP_MTIME = 0.0


def unescape_java_prop(s: str) -> str:
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt in (":", "=", "#", "!"):
                out.append(nxt)
                i += 2
                continue
            if nxt == "u" and i + 5 < n:
                try:
                    out.append(chr(int(s[i + 2 : i + 6], 16)))
                    i += 6
                    continue
                except Exception:
                    pass
            if nxt == "\\":
                out.append("\\")
                i += 2
                continue
        out.append(c)
        i += 1
    return "".join(out)


def load_imdb_map():
    global SIMKL_MAP_MTIME
    try:
        if not os.path.isfile(NUVIO_SIMKL_PATH):
            return
        mt = os.path.getmtime(NUVIO_SIMKL_PATH)
        if mt == SIMKL_MAP_MTIME and IMDB_MAP:
            return
        SIMKL_MAP_MTIME = mt
        raw = open(NUVIO_SIMKL_PATH, encoding="utf-8", errors="ignore").read()
        for m in re.finditer(r"^simkl_sync_snapshot_\d+=(.+)$", raw, flags=re.M):
            data = json.loads(unescape_java_prop(m.group(1)))
            for entry in data.get("entries") or []:
                mtype = entry.get("mediaType")
                media = entry.get("show") or entry.get("movie") or entry.get("anime") or {}
                ids = media.get("ids") or {}
                imdb = ids.get("imdb")
                if imdb:
                    IMDB_MAP[imdb] = {
                        "simkl": str(ids.get("simkl") or ""),
                        "tmdb": ids.get("tmdb"),
                        "slug": ids.get("slug"),
                        "type": "anime" if mtype == "anime" else ("movie" if mtype == "movies" else "show"),
                    }
            for pb in data.get("playback") or []:
                media = pb.get("show") or pb.get("movie") or pb.get("anime") or {}
                ids = media.get("ids") or {}
                imdb = ids.get("imdb")
                if imdb and imdb not in IMDB_MAP:
                    IMDB_MAP[imdb] = {
                        "simkl": str(ids.get("simkl") or ""),
                        "tmdb": ids.get("tmdb"),
                        "slug": ids.get("slug"),
                        "type": "anime" if pb.get("anime") else ("movie" if pb.get("movie") else "show"),
                    }
    except Exception:
        pass


def get_active_profile_index():
    try:
        prof_path = os.path.join(NUVIO_DIR, "nuvio_profiles.properties")
        if os.path.isfile(prof_path):
            raw = open(prof_path, encoding="utf-8", errors="ignore").read()
            m = re.search(r"^profiles=(.+)$", raw, flags=re.M)
            if m:
                d = json.loads(unescape_java_prop(m.group(1)))
                idx = d.get("activeProfileIndex")
                if idx is not None:
                    return int(idx)
    except Exception:
        pass
    return 1


def read_nuvio_entries():
    try:
        if not os.path.isfile(NUVIO_PROGRESS_PATH):
            return []
        raw = open(NUVIO_PROGRESS_PATH, encoding="utf-8", errors="ignore").read()
        target_idx = get_active_profile_index()
        m = re.search(rf"^watch_progress_{target_idx}=(.+)$", raw, flags=re.M)
        if not m:
            m = re.search(r"^watch_progress_1=(.+)$", raw, flags=re.M)
        if not m:
            return []
        data = json.loads(unescape_java_prop(m.group(1)))
        entries = [e for e in (data.get("entries") or []) if isinstance(e, dict)]
        entries.sort(key=lambda x: int(x.get("lastUpdatedEpochMs") or 0), reverse=True)
        return entries
    except Exception:
        return []


def tmdb_get(path: str, params: dict):
    q = urllib.parse.urlencode({**params, "api_key": TMDB_KEY})
    url = f"https://api.themoviedb.org/3{path}?{q}"
    req = urllib.request.Request(url, headers={"User-Agent": "uWaazy-hub/1.6"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def is_generic_ep_name(name: str) -> bool:
    if not name:
        return True
    return bool(re.match(r"^(?:Epis[oó]dio|Episode|Cap[ií]tulo|Ep\.?)\s*\d+$", name.strip(), flags=re.I))


def resolve_i18n(title, media_type, season, number, imdb_id=None, tmdb_id=None, fallback_ep_title=None, fallback_poster=None):
    cache_key = f"{media_type}|{imdb_id or ''}|{tmdb_id or ''}|{title}|{season or ''}|{number or ''}"
    cached = I18N_CACHE.get(cache_key)
    if cached and (time.time() - cached["at"] < 21600):
        return cached["data"]

    kind = "movie" if media_type == "movie" else "tv"
    resolved_tmdb_id = tmdb_id
    resolved_imdb_id = imdb_id

    if not resolved_tmdb_id and resolved_imdb_id:
        try:
            found = tmdb_get(f"/find/{resolved_imdb_id}", {"external_source": "imdb_id", "language": "en-US"})
            arr = found.get("movie_results" if kind == "movie" else "tv_results") or found.get("tv_results") or found.get("movie_results") or []
            if arr:
                resolved_tmdb_id = arr[0].get("id")
                if not found.get("movie_results") and found.get("tv_results"):
                    kind = "tv"
        except Exception:
            pass

    if not resolved_tmdb_id and title:
        try:
            srch = tmdb_get(f"/search/{kind}", {"query": title, "language": "en-US"})
            arr = srch.get("results") or []
            if arr:
                resolved_tmdb_id = arr[0].get("id")
        except Exception:
            pass

    lang_map = {"pt": "pt-BR", "en": "en-US", "es": "es-ES"}
    i18n = {}
    tmdb_runtime = None

    if resolved_tmdb_id:
        for short_lang, tmdb_lang in lang_map.items():
            loc_title = title
            loc_ep = fallback_ep_title
            loc_poster = fallback_poster
            try:
                det = tmdb_get(f"/{kind}/{resolved_tmdb_id}", {"language": tmdb_lang})
                if det:
                    loc_title = det.get("title") or det.get("name") or title
                    if det.get("poster_path"):
                        loc_poster = f"https://image.tmdb.org/t/p/w500{det['poster_path']}"
                    if not tmdb_runtime:
                        rt = det.get("runtime") or ((det.get("episode_run_time") or [None])[0])
                        if rt:
                            tmdb_runtime = int(rt)
            except Exception:
                pass
            if kind == "tv" and number is not None:
                s_query = season if season is not None else 1
                try:
                    ep_det = tmdb_get(f"/tv/{resolved_tmdb_id}/season/{s_query}/episode/{number}", {"language": tmdb_lang})
                    if ep_det:
                        ep_name = ep_det.get("name")
                        if ep_name and (not is_generic_ep_name(ep_name) or not fallback_ep_title):
                            loc_ep = ep_name
                        if ep_det.get("runtime") and not tmdb_runtime:
                            tmdb_runtime = int(ep_det["runtime"])
                except Exception:
                    pass
            i18n[short_lang] = {
                "title": loc_title,
                "episodeTitle": loc_ep,
                "poster": loc_poster,
            }
    else:
        for short_lang in ("pt", "en", "es"):
            i18n[short_lang] = {
                "title": title,
                "episodeTitle": fallback_ep_title,
                "poster": fallback_poster,
            }

    en_ep = (i18n.get("en") or {}).get("episodeTitle")
    if en_ep and not is_generic_ep_name(en_ep):
        for short_lang in ("pt", "es"):
            if short_lang in i18n and is_generic_ep_name(i18n[short_lang].get("episodeTitle") or ""):
                i18n[short_lang]["episodeTitle"] = en_ep

    out = {"i18n": i18n, "tmdbId": resolved_tmdb_id, "imdbId": resolved_imdb_id, "tmdbRuntimeMin": tmdb_runtime}
    I18N_CACHE[cache_key] = {"at": time.time(), "data": out}
    return out


def is_nuvio_running():
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.check_output(
            ["tasklist", "/FI", "IMAGENAME eq Nuvio.exe", "/NH"],
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            timeout=2,
        )
        return b"Nuvio.exe" in out
    except Exception:
        return True


def detect_live_from_nuvio():
    if not is_nuvio_running():
        return None
    entries = read_nuvio_entries()
    if not entries:
        return None
    top = entries[0]
    now_ms = int(time.time() * 1000)
    upd_ms = int(top.get("lastUpdatedEpochMs") or 0)
    if top.get("isCompleted") or (now_ms - upd_ms) > 35000:
        return None
    dur_ms = int(top.get("durationMs") or 0)
    pos_ms = int(top.get("lastPositionMs") or 0)
    if dur_ms > 0 and pos_ms >= dur_ms * 0.98:
        return None

    imdb_id = top.get("parentMetaId")
    is_mov = top.get("contentType") == "movie" or top.get("parentMetaType") == "movie"
    season_num = top.get("seasonNumber")
    ep_num = top.get("episodeNumber")
    raw_title = top.get("title") or ""
    raw_ep_title = top.get("episodeTitle")
    raw_poster = top.get("poster")

    load_imdb_map()
    mapped = IMDB_MAP.get(str(imdb_id or "")) or {}
    media_type = mapped.get("type") or ("movie" if is_mov else "show")
    simkl_id = mapped.get("simkl") or None
    tmdb_id = mapped.get("tmdb") or None

    episode = None
    if not is_mov and ep_num is not None:
        if season_num is not None:
            episode = f"S{int(season_num):02d}E{int(ep_num):02d}"
        else:
            episode = f"Ep. {int(ep_num)}"

    loc_info = resolve_i18n(
        raw_title,
        media_type,
        season_num,
        ep_num,
        imdb_id=imdb_id,
        tmdb_id=tmdb_id,
        fallback_ep_title=raw_ep_title,
        fallback_poster=raw_poster,
    )
    i18n = loc_info.get("i18n") or {}
    en_loc = i18n.get("en") or {}

    duration_sec = round(dur_ms / 1000.0) if dur_ms > 60000 else ((loc_info.get("tmdbRuntimeMin") or (105 if is_mov else 24)) * 60)
    runtime_min = max(1, round(duration_sec / 60.0))
    started_ms = (upd_ms - pos_ms) if (now_ms - upd_ms) <= 65000 else (now_ms - pos_ms)
    elapsed_sec = max(0, round((now_ms - started_ms) / 1000.0))
    progress = max(0, min(99, round((elapsed_sec / max(1, duration_sec)) * 100)))

    simkl_path_kind = "movies" if media_type == "movie" else ("anime" if media_type == "anime" else "tv")
    url = f"https://simkl.com/{simkl_path_kind}/{simkl_id}" if simkl_id else DASHBOARD_URL

    return {
        "live": True,
        "paused": False,
        "title": en_loc.get("title") or raw_title,
        "type": media_type,
        "season": season_num,
        "number": ep_num,
        "episode": episode,
        "episodeTitle": en_loc.get("episodeTitle") or raw_ep_title,
        "imdbId": loc_info.get("imdbId") or imdb_id,
        "tmdbId": loc_info.get("tmdbId") or tmdb_id,
        "simklId": simkl_id,
        "watchedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(started_ms / 1000.0)),
        "startedAt": started_ms,
        "startProgress": 0.0,
        "runtimeMin": runtime_min,
        "durationSec": duration_sec,
        "elapsedSec": elapsed_sec,
        "progress": progress,
        "poster": en_loc.get("poster") or raw_poster,
        "i18n": i18n,
        "url": url,
        "source": "nuvio-live-sync",
    }


def iso_to_ms(value):
    try:
        return int(calendar.timegm(time.strptime(str(value)[:19], "%Y-%m-%dT%H:%M:%S")) * 1000)
    except Exception:
        return 0


def load_saved_last():
    try:
        with open(LAST_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) and data.get("title") else None
    except Exception:
        return None


def save_last(item):
    try:
        tmp = LAST_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(item, fh)
        os.replace(tmp, LAST_PATH)
    except Exception:
        pass


def finish_live_item(live_item):
    done = {k: v for k, v in live_item.items() if k not in ("startedAt", "startProgress", "elapsedSec", "progress")}
    done["live"] = False
    done["paused"] = False
    done["source"] = "nuvio-history"
    done["watchedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    return done


def get_last_watched_nuvio():
    from_file = get_last_from_nuvio_file()
    saved = load_saved_last()
    if saved and (not from_file or iso_to_ms(saved.get("watchedAt")) >= iso_to_ms(from_file.get("watchedAt"))):
        return saved
    return from_file


def get_last_from_nuvio_file():
    entries = read_nuvio_entries()
    if not entries:
        return None
    top = entries[0]
    imdb_id = top.get("parentMetaId")
    is_mov = top.get("contentType") == "movie" or top.get("parentMetaType") == "movie"
    season_num = top.get("seasonNumber")
    ep_num = top.get("episodeNumber")
    raw_title = top.get("title") or ""
    raw_ep_title = top.get("episodeTitle")
    raw_poster = top.get("poster")
    upd_ms = int(top.get("lastUpdatedEpochMs") or 0)

    load_imdb_map()
    mapped = IMDB_MAP.get(str(imdb_id or "")) or {}
    media_type = mapped.get("type") or ("movie" if is_mov else "show")
    simkl_id = mapped.get("simkl") or None
    tmdb_id = mapped.get("tmdb") or None

    episode = None
    if not is_mov and ep_num is not None:
        if season_num is not None:
            episode = f"S{int(season_num):02d}E{int(ep_num):02d}"
        else:
            episode = f"Ep. {int(ep_num)}"

    loc_info = resolve_i18n(
        raw_title,
        media_type,
        season_num,
        ep_num,
        imdb_id=imdb_id,
        tmdb_id=tmdb_id,
        fallback_ep_title=raw_ep_title,
        fallback_poster=raw_poster,
    )
    i18n = loc_info.get("i18n") or {}
    en_loc = i18n.get("en") or {}
    simkl_path_kind = "movies" if media_type == "movie" else ("anime" if media_type == "anime" else "tv")
    url = f"https://simkl.com/{simkl_path_kind}/{simkl_id}" if simkl_id else DASHBOARD_URL

    return {
        "live": False,
        "paused": False,
        "title": en_loc.get("title") or raw_title,
        "type": media_type,
        "season": season_num,
        "number": ep_num,
        "episode": episode,
        "episodeTitle": en_loc.get("episodeTitle") or raw_ep_title,
        "imdbId": loc_info.get("imdbId") or imdb_id,
        "tmdbId": loc_info.get("tmdbId") or tmdb_id,
        "simklId": simkl_id,
        "watchedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(upd_ms / 1000.0 if upd_ms else time.time())),
        "poster": en_loc.get("poster") or raw_poster,
        "i18n": i18n,
        "url": url,
        "source": "nuvio-history",
    }


def format_for_lang(item: dict, lang: str = "en") -> dict:
    now_ms = int(time.time() * 1000)
    out = dict(item)
    started_ms = int(out.get("startedAt") or now_ms)
    duration_sec = int(out.get("durationSec") or (int(out.get("runtimeMin") or 100) * 60))
    elapsed_sec = max(0, round((now_ms - started_ms) / 1000.0))
    prog = min(99, round((elapsed_sec / max(1, duration_sec)) * 100))
    out["elapsedSec"] = elapsed_sec
    out["durationSec"] = duration_sec
    out["progress"] = max(0, min(99, prog))

    i18n = out.get("i18n") or {}
    loc = i18n.get(lang) or i18n.get("en") or {}
    if loc.get("title"):
        out["title"] = loc["title"]
    if loc.get("episodeTitle"):
        out["episodeTitle"] = loc["episodeTitle"]
    if loc.get("poster"):
        out["poster"] = loc["poster"]
    return out


def push_to_hub(payload: dict):
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            HUB_API_URL,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {HUB_SECRET}",
                "User-Agent": "uWaazy-simkl-sync/1.7",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            resp.read()
    except Exception:
        pass


class LocalBridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed_url.query)
        lang = (qs.get("lang", ["en"])[0] or "en")[:2].lower()
        if lang not in ("pt", "en", "es"):
            lang = "en"

        self.send_response(200)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        live_item = detect_live_from_nuvio()
        if live_item:
            STATE["live"] = True
            STATE["item"] = live_item
            out = format_for_lang(live_item, lang)
            self.wfile.write(json.dumps(out).encode("utf-8"))
        else:
            STATE["live"] = False
            STATE["item"] = None
            last_item = get_last_watched_nuvio()
            if last_item:
                out = format_for_lang(last_item, lang)
                out["live"] = False
                self.wfile.write(json.dumps(out).encode("utf-8"))
            else:
                self.wfile.write(json.dumps({"live": False}).encode("utf-8"))


def start_http_server():
    try:
        srv = HTTPServer(("127.0.0.1", LOCAL_PORT), LocalBridgeHandler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        return True
    except OSError:
        return False


def run_daemon():
    if not start_http_server():
        return
    init_last = get_last_watched_nuvio()
    if init_last:
        push_to_hub({"state": "idle", "lastItem": init_last})
    last_state_was_live = False
    last_live_item = None
    last_push_ts = 0.0
    last_pushed_pos = -1
    while True:
        try:
            parsed = detect_live_from_nuvio()
            now = time.time()
            if parsed:
                STATE["live"] = True
                STATE["item"] = parsed
                STATE["updatedAt"] = int(now * 1000)
                last_live_item = parsed
                el_sec = int(parsed.get("elapsedSec") or 0)
                if not last_state_was_live or (now - last_push_ts >= 20.0) or abs(el_sec - last_pushed_pos) > 30:
                    push_to_hub({"state": "watching", "item": parsed})
                    last_push_ts = now
                    last_pushed_pos = el_sec
                    last_state_was_live = True
            else:
                if last_state_was_live:
                    STATE["live"] = False
                    STATE["item"] = None
                    STATE["updatedAt"] = int(now * 1000)
                    last_watched = finish_live_item(last_live_item) if last_live_item else get_last_watched_nuvio()
                    if last_watched:
                        save_last(last_watched)
                    push_to_hub({"state": "idle", "lastItem": last_watched})
                    last_state_was_live = False
                    last_live_item = None
                else:
                    STATE["live"] = False
                    STATE["item"] = None
        except Exception:
            pass
        time.sleep(3.0)


if __name__ == "__main__":
    run_daemon()
