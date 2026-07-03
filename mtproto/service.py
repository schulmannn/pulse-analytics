"""
Atlavue — MTProto микросервис
Python + Telethon + FastAPI
"""

import asyncio
import os
import json
import logging
import re
import secrets
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Optional

from fastapi import Body, Depends, FastAPI, HTTPException, Header, Query, Response
from fastapi.responses import JSONResponse
import uvicorn
from telethon import TelegramClient
from telethon.errors import FloodWaitError, PasswordHashInvalidError, SessionPasswordNeededError
from telethon.sessions import StringSession
from telethon.tl.functions.stats import GetBroadcastStatsRequest, LoadAsyncGraphRequest, GetMessageStatsRequest
from telethon.tl.functions.channels import GetFullChannelRequest, SearchPostsRequest, CheckSearchPostsFloodRequest, GetAdminedPublicChannelsRequest
from telethon.tl.types import StatsGraph, StatsGraphAsync, InputPeerEmpty, PeerChannel
from dotenv import load_dotenv

load_dotenv()

# ── Сессия твоего ЛИЧНОГО аккаунта (StringSession) ────────
# Генерируется один раз локально и кладётся в переменную окружения TG_SESSION.
# Через личный профиль доступны просмотры, репосты, реакции и статистика канала,
# которых нет в Bot API. Это не файл-сессия — base64 больше не нужен.

# ── Logging ──────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────
API_ID       = int(os.getenv('TG_API_ID', '0'))
API_HASH     = os.getenv('TG_API_HASH', '')
SESSION      = os.getenv('TG_SESSION', '')
PHONE        = os.getenv('TG_PHONE', '')
CHANNEL      = os.getenv('TG_CHANNEL', '')
# Internal-auth token for web → mtproto calls; the web service sends the same
# value in x-internal-token. Fail-closed: when unset, data routes answer 503
# instead of serving openly (see check_auth).
MTPROTO_TOKEN = os.getenv('MTPROTO_TOKEN', '')
MTPROTO_PORT = int(os.getenv('MTPROTO_PORT', '8001'))

# ── Mentions (channels.searchPosts — requires Premium; ~10 free searches/day) ──
_DEFAULT_MENTION_QUERIES = ['nōtem', 'notem', '@bynotem']
MENTION_QUERIES = [q.strip() for q in os.getenv('MENTION_QUERIES', '').split(',') if q.strip()] or _DEFAULT_MENTION_QUERIES
# channels NOT counted as mentions (own brand channel); default = configured channel
_own = (CHANNEL or '').lstrip('@').lower()
MENTION_EXCLUDE = set(u.strip().lstrip('@').lower()
                      for u in (os.getenv('MENTION_EXCLUDE') or _own or 'bynotem').split(',') if u.strip())
MENTION_SMART_FILTER = os.getenv('MENTION_SMART_FILTER', '1') != '0'

# ── FastAPI ──────────────────────────────────────────────
# Server-to-server only (the web service calls it over the private network with an
# internal token) — no browser ever talks to it, so no CORS middleware.
app = FastAPI(title='Atlavue MTProto Service', version='1.0.0')


# FloodWait — Telegram throttled the session. An expected condition, not an outage:
# answer 429 with retry_after so the web proxy can tell the dashboard to retry later.
# Endpoint-level `except Exception` blocks re-raise FloodWaitError so it lands here.
@app.exception_handler(FloodWaitError)
async def flood_wait_handler(request, exc):
    seconds = int(getattr(exc, 'seconds', 0) or 0)
    log.warning(f'FloodWait: {seconds}s ({request.url.path})')
    return JSONResponse(status_code=429, content={'detail': 'flood_wait', 'retry_after': seconds})


# One heavy-stats request at a time: parallel GetBroadcastStats/GetMessageStats
# fan-out on the single Telethon session is exactly what trips FloodWait. Attached
# as a route dependency so direct function calls (the collector) stay unserialized.
_STATS_LOCK = asyncio.Semaphore(1)


async def _serialize_stats():
    async with _STATS_LOCK:
        yield


# ── Telethon client ──────────────────────────────────────
client: Optional[TelegramClient] = None
_CLIENT_LOCK = asyncio.Lock()


async def get_client() -> TelegramClient:
    global client
    if client and client.is_connected():
        return client
    async with _CLIENT_LOCK:
        # double-check: another coroutine may have (re)connected while we waited
        if client and client.is_connected():
            return client
        if not SESSION:
            raise RuntimeError('TG_SESSION не задан — добавь строку сессии в переменные окружения')
        new_client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
        await new_client.connect()
        if not await new_client.is_user_authorized():
            raise RuntimeError('TG_SESSION недействителен или истёк — сгенерируй заново')
        client = new_client
        log.info('Telethon client connected (StringSession)')
        return client


def check_auth(x_internal_token: str = Header(default='')):
    # FAIL-CLOSED: an unset token must never mean "auth off" (the legacy shared-
    # password behaviour served everything openly when the env was empty).
    if not MTPROTO_TOKEN:
        raise HTTPException(status_code=503, detail='token_not_configured')
    if not secrets.compare_digest(x_internal_token, MTPROTO_TOKEN):
        raise HTTPException(status_code=401, detail='Unauthorized')


# ── Album-aware post building ─────────────────────────────
# Telegram albums (media groups) arrive as several messages sharing one
# `grouped_id`. Treating each as a separate post inflates post counts, daily
# views and pollutes the top-posts list with caption-less fragments. We collapse
# a group into ONE logical post before counting anything.

_HASHTAG_RE = re.compile('#([0-9A-Za-z_Ѐ-ӿ]{2,})')


def _extract_hashtags(text):
    if not text:
        return []
    out, seen = [], set()
    for tag in _HASHTAG_RE.findall(text):
        low = tag.lower()
        if low not in seen:
            seen.add(low)
            out.append('#' + tag)
    return out[:15]


def _react_total(msg):
    if msg and msg.reactions and msg.reactions.results:
        return sum(r.count for r in msg.reactions.results)
    return 0


def _media_type(msg):
    if msg.photo:       return 'photo'
    if msg.video:       return 'video'
    if msg.document:    return 'document'
    if msg.poll:        return 'poll'
    if msg.audio:       return 'audio'
    if msg.voice:       return 'voice'
    if msg.web_preview: return 'link'
    return 'text'


def _logical_posts(messages):
    """Collapse album (grouped_id) messages into single logical posts,
    preserving the newest-first order Telethon returns."""
    groups = {}
    ordered = []
    for msg in messages:
        if not msg or msg.action:
            continue
        gid = getattr(msg, 'grouped_id', None)
        if gid:
            if gid not in groups:
                groups[gid] = []
                ordered.append(('g', gid))
            groups[gid].append(msg)
        else:
            ordered.append(('m', [msg]))
    return [groups[v] if kind == 'g' else v for kind, v in ordered]


def _build_post(group):
    """Build one post dict from a group of messages (1 = normal post, >1 = album)."""
    rep       = max(group, key=lambda m: (m.views or 0))                # most-viewed → used for thumb/per-post stats
    cap_msg   = next((m for m in group if (m.text or m.message)), rep)  # the message carrying the caption
    react_msg = max(group, key=_react_total)                            # album reactions live on a single message
    earliest  = min(group, key=lambda m: m.id)                          # album posts share a moment; first id = post time

    reactions_detail, reactions_total = [], 0
    if react_msg.reactions and react_msg.reactions.results:
        for r in react_msg.reactions.results:
            emoji = getattr(r.reaction, 'emoticon', '?')
            reactions_detail.append({'emoji': emoji, 'count': r.count})
            reactions_total += r.count

    full_text = ' '.join((m.text or m.message or '') for m in group)
    caption   = (cap_msg.text or cap_msg.message or '')

    return {
        'id':               rep.id,
        'date':             earliest.date.isoformat(),
        'text':             caption[:200],
        'views':            max((m.views or 0) for m in group),
        'forwards':         max((m.forwards or 0) for m in group),
        'replies':          max((getattr(m.replies, 'replies', 0) if m.replies else 0) for m in group),
        'reactions':        reactions_total,
        'reactions_detail': reactions_detail,
        'media_type':       _media_type(rep),
        'hashtags':         _extract_hashtags(full_text),
        'album_size':       len(group) if len(group) > 1 else 0,
        'pinned':           any(bool(m.pinned) for m in group),
    }


# ── Stats-graph helpers (shared by velocity / future endpoints) ──
async def _resolve_graph(tg, g):
    if isinstance(g, StatsGraphAsync):
        try:
            g = await tg(LoadAsyncGraphRequest(token=g.token))
        except FloodWaitError:
            raise          # throttled → the whole request must answer 429, not degrade
        except Exception:
            return None
    if isinstance(g, StatsGraph):
        try:
            return json.loads(g.json.data)
        except Exception:
            return None
    return None


def _cols_of(data):
    cols = data.get('columns', [])
    names = data.get('names', {})
    types = data.get('types', {})
    x, series = [], []
    for c in cols:
        cid, vals = c[0], c[1:]
        if cid == 'x':
            x = vals
        else:
            series.append({'name': names.get(cid, cid), 'type': types.get(cid, 'line'), 'values': vals})
    return x, series


def _g_timeseries(data, last=45):
    if not data:
        return None
    x, series = _cols_of(data)
    x = x[-last:]
    for s in series:
        s['values'] = s['values'][-last:]
    return {'x': x, 'series': series}


def _g_aggregate(data, top=8):
    if not data:
        return None
    _, series = _cols_of(data)
    agg = [{'label': s['name'], 'value': sum(v or 0 for v in s['values'])} for s in series]
    agg = [a for a in agg if a['value'] > 0]
    agg.sort(key=lambda a: a['value'], reverse=True)
    return agg[:top]


def _g_sum_daily(data):
    """Sum all y-series per x-point → {x, values} (e.g. total reactions/day)."""
    if not data:
        return None
    x, series = _cols_of(data)
    if not series:
        return None
    n = len(series[0]['values'])
    return {'x': x, 'values': [sum((s['values'][i] or 0) for s in series) for i in range(n)]}


@app.get('/health')
async def health():
    # Liveness only. Unauthenticated (container healthcheck hits it), so it must
    # not leak config — no channel name, no connection details.
    return {'ok': True}


@app.get('/channel')
async def get_channel(x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)
        full = await tg(GetFullChannelRequest(entity))
        chat = full.chats[0]
        fc = full.full_chat
        return {
            'id':          chat.id,
            'title':       chat.title,
            'username':    getattr(chat, 'username', ''),
            'description': getattr(fc, 'about', ''),
            'members':     getattr(fc, 'participants_count', 0),
            'admins':      getattr(fc, 'admins_count', 0),
            'online':      getattr(fc, 'online_count', 0),
        }
    except FloodWaitError:
        raise
    except Exception as e:
        log.error(f'get_channel error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/posts')
async def get_posts(
    limit: int = Query(default=30, le=100),
    offset_id: int = Query(default=0),
    x_internal_token: str = Header(default=''),
):
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        messages = await tg.get_messages(CHANNEL, limit=limit, offset_id=offset_id or 0)
        posts = [_build_post(g) for g in _logical_posts(messages)]
        return {'posts': posts, 'count': len(posts)}

    except FloodWaitError:
        raise
    except Exception as e:
        log.error(f'get_posts error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/views_summary', dependencies=[Depends(_serialize_stats)])
async def get_views_summary(
    limit: int = Query(default=30, le=100),
    x_internal_token: str = Header(default=''),
):
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        msgs = await tg.get_messages(CHANNEL, limit=limit)
        posts = [_build_post(g) for g in _logical_posts(msgs)]   # album-collapsed

        total_views = total_forwards = total_reactions = total_replies = 0
        views_by_day = {}
        views_by_type = {}

        for p in posts:
            v = p['views']
            total_views     += v
            total_forwards  += p['forwards']
            total_reactions += p['reactions']
            total_replies   += p['replies']

            day = p['date'][8:10] + '.' + p['date'][5:7]   # DD.MM from ISO date
            views_by_day[day] = views_by_day.get(day, 0) + v

            views_by_type.setdefault(p['media_type'], []).append(v)

        avg_by_type = {
            t: int(sum(vs) / len(vs))
            for t, vs in views_by_type.items() if vs
        }
        n = len(posts)

        return {
            'total_views':       total_views,
            'total_forwards':    total_forwards,
            'total_reactions':   total_reactions,
            'total_replies':     total_replies,
            'posts_analyzed':    n,
            'avg_views':         total_views // max(n, 1),
            'avg_forwards':      total_forwards // max(n, 1),
            'views_by_day':      views_by_day,
            'avg_views_by_type': avg_by_type,
        }

    except FloodWaitError:
        raise
    except Exception as e:
        log.error(f'views_summary error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/stats', dependencies=[Depends(_serialize_stats)])
async def get_stats(x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)
        stats = await tg(GetBroadcastStatsRequest(channel=entity, dark=False))

        def extract(obj):
            if obj is None:
                return None
            if hasattr(obj, 'current'):
                return {
                    'current':  getattr(obj.current,  'value', obj.current),
                    'previous': getattr(obj.previous, 'value', None),
                }
            return obj

        return {
            'followers':             extract(getattr(stats, 'followers', None)),
            'views_per_post':        extract(getattr(stats, 'views_per_post', None)),
            'shares_per_post':       extract(getattr(stats, 'shares_per_post', None)),
            'reactions_per_post':    extract(getattr(stats, 'reactions_per_post', None)),
            'enabled_notifications': extract(getattr(stats, 'enabled_notifications', None)),
        }

    except FloodWaitError:
        raise
    except Exception as e:
        return {'available': False, 'error': str(e)}


@app.get('/graphs', dependencies=[Depends(_serialize_stats)])
async def get_graphs(points: int = Query(default=45, le=400), x_internal_token: str = Header(default='')):
    """Rich channel stats graphs: subscriber growth, view/follower sources,
    audience by hour, languages, reaction sentiment."""
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)
        stats = await tg(GetBroadcastStatsRequest(channel=entity, dark=False))

        async def resolve(g):
            if isinstance(g, StatsGraphAsync):
                try:
                    g = await tg(LoadAsyncGraphRequest(token=g.token))
                except FloodWaitError:
                    raise
                except Exception:
                    return None
            if isinstance(g, StatsGraph):
                try:
                    return json.loads(g.json.data)
                except Exception:
                    return None
            return None

        def cols_of(data):
            cols  = data.get('columns', [])
            names = data.get('names', {})
            types = data.get('types', {})
            x, series = [], []
            for c in cols:
                cid, vals = c[0], c[1:]
                if cid == 'x':
                    x = vals
                else:
                    series.append({'name': names.get(cid, cid),
                                   'type': types.get(cid, 'line'),
                                   'values': vals})
            return x, series

        def timeseries(data, last=45):
            if not data:
                return None
            x, series = cols_of(data)
            x = x[-last:]
            for s in series:
                s['values'] = s['values'][-last:]
            return {'x': x, 'series': series}

        def aggregate(data, top=8):
            if not data:
                return None
            _, series = cols_of(data)
            agg = [{'label': s['name'], 'value': sum(v or 0 for v in s['values'])} for s in series]
            agg = [a for a in agg if a['value'] > 0]
            agg.sort(key=lambda a: a['value'], reverse=True)
            return agg[:top]

        def sum_daily(data):
            """Sum all y-series per x-point → {x, values} (e.g. total reactions/day)."""
            if not data:
                return None
            x, series = cols_of(data)
            if not series:
                return None
            n = len(series[0]['values'])
            return {'x': x, 'values': [sum((s['values'][i] or 0) for s in series) for i in range(n)]}

        top_hours = None
        th = await resolve(getattr(stats, 'top_hours_graph', None))
        if th:
            x, series = cols_of(th)
            if series:
                top_hours = {'hours': x, 'values': series[0]['values'], 'name': series[0]['name']}

        emotion = await resolve(getattr(stats, 'reactions_by_emotion_graph', None))

        return {
            'available':                True,
            'growth':                   timeseries(await resolve(getattr(stats, 'growth_graph', None)), points),
            'followers':                timeseries(await resolve(getattr(stats, 'followers_graph', None)), points),
            'views_by_source':          aggregate(await resolve(getattr(stats, 'views_by_source_graph', None))),
            'new_followers_by_source':  aggregate(await resolve(getattr(stats, 'new_followers_by_source_graph', None))),
            'languages':                aggregate(await resolve(getattr(stats, 'languages_graph', None)), top=6),
            'reactions_sentiment':      aggregate(emotion),
            'reactions_daily':          sum_daily(emotion),
            'interactions':             timeseries(await resolve(getattr(stats, 'interactions_graph', None)), points),
            'top_hours':                top_hours,
        }
    except FloodWaitError:
        raise
    except Exception as e:
        log.error(f'get_graphs error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/post_stats/{msg_id}', dependencies=[Depends(_serialize_stats)])
async def get_post_stats(msg_id: int, x_internal_token: str = Header(default='')):
    """Per-post detailed stats (GetMessageStats): views-over-time + reactions.
    May be unavailable for posts with too few views."""
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)
        st = await tg(GetMessageStatsRequest(channel=entity, msg_id=msg_id, dark=False))

        async def resolve(g):
            if isinstance(g, StatsGraphAsync):
                try:
                    g = await tg(LoadAsyncGraphRequest(token=g.token))
                except FloodWaitError:
                    raise
                except Exception:
                    return None
            if isinstance(g, StatsGraph):
                try:
                    return json.loads(g.json.data)
                except Exception:
                    return None
            return None

        def cols_of(data):
            cols = data.get('columns', [])
            names = data.get('names', {})
            types = data.get('types', {})
            x, series = [], []
            for c in cols:
                cid, vals = c[0], c[1:]
                if cid == 'x':
                    x = vals
                else:
                    series.append({'name': names.get(cid, cid), 'type': types.get(cid, 'line'), 'values': vals})
            return x, series

        views = None
        vg = await resolve(getattr(st, 'views_graph', None))
        if vg:
            x, series = cols_of(vg)
            views = {'x': x, 'series': series}

        reactions = None
        rg = await resolve(getattr(st, 'reactions_by_emotion_graph', None))
        if rg:
            _, rseries = cols_of(rg)
            agg = [{'label': s['name'], 'value': sum(v or 0 for v in s['values'])} for s in rseries]
            reactions = sorted([a for a in agg if a['value'] > 0], key=lambda a: a['value'], reverse=True)

        return {'available': True, 'views_graph': views, 'reactions': reactions}
    except FloodWaitError:
        raise
    except Exception as e:
        log.error(f'get_post_stats error: {e}')
        return {'available': False, 'error': str(e)}


@app.get('/velocity', dependencies=[Depends(_serialize_stats)])
async def get_velocity(
    limit: int = Query(default=40, le=100),
    top: int = Query(default=12, le=20),
    x_internal_token: str = Header(default=''),
):
    """Channel-level "post lifecycle": how a post's views accrue over the days
    after publishing. Telegram's per-message views_graph is INCREMENTAL (new
    views per bucket) and usually DAILY, so we aggregate increments into
    day-since-publish buckets and average the share of total reach per day."""
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)
        msgs = await tg.get_messages(CHANNEL, limit=limit)
        posts = [_build_post(g) for g in _logical_posts(msgs)]
        cand = [p for p in posts if p['views'] >= 80][:top]

        MAXD = 7
        share_by_day = [[] for _ in range(MAXD)]   # per day: list of per-post % shares
        cum_by_day   = [[] for _ in range(MAXD)]
        day1, t80d = [], []
        used = 0

        for p in cand:
            try:
                st = await tg(GetMessageStatsRequest(channel=entity, msg_id=p['id'], dark=False))
            except FloodWaitError:
                raise
            except Exception:
                continue
            data = await _resolve_graph(tg, getattr(st, 'views_graph', None))
            if not data:
                continue
            x, series = _cols_of(data)
            if not series or not x or len(x) < 2:
                continue
            raw = [float(v or 0) for v in series[0]['values']]   # incremental new views per bucket
            if len(raw) != len(x):
                continue
            total = sum(raw)
            if total <= 0:
                continue
            t0 = float(x[0])
            last_d = int((float(x[-1]) - t0) // 86400000)
            if last_d < 2:
                continue   # too young: lifecycle not settled → would bias the curve
            day = [0.0] * MAXD
            for i, v in enumerate(raw):
                d = int((float(x[i]) - t0) // 86400000)   # full days since first bucket
                if 0 <= d < MAXD:
                    day[d] += v
            days_present = min(MAXD, last_d + 1)           # only count days the post has actually lived
            cum = 0.0
            cumpct = []
            for d in range(days_present):
                cum += day[d]
                cp = cum / total * 100.0
                cumpct.append(cp)
                share_by_day[d].append(day[d] / total * 100.0)
                cum_by_day[d].append(cp)
            day1.append(day[0] / total * 100.0)
            for d in range(days_present):
                if cumpct[d] >= 80:
                    t80d.append(d)
                    break
            used += 1

        if used < 1:
            return {'available': False, 'posts_used': 0}

        def avg(a):
            return round(sum(a) / len(a), 1) if a else None

        def med(a):
            if not a:
                return None
            a = sorted(a); n = len(a)
            return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2

        by_day = [{'day': d, 'share': avg(share_by_day[d]), 'cum': avg(cum_by_day[d])}
                  for d in range(MAXD) if share_by_day[d]]
        t80_med = med(t80d)
        return {
            'available':  True,
            'posts_used': used,
            'by_day':     by_day,
            'day1_share': avg(day1),
            't80_days':   (int(t80_med) + 1) if t80_med is not None else None,
        }
    except FloodWaitError:
        raise
    except Exception as e:
        # реальный сбой (сеть/сессия/неожиданное) → честный 5xx для мониторинга.
        # Легитимный «нет подходящих постов» отдаётся выше как 200 {available:False}.
        log.error(f'velocity error: {e}')
        raise HTTPException(status_code=503, detail=str(e))


# ── Mentions helpers (reused from notem-mention-monitor) ──
_CYRILLIC_RE = re.compile('[а-яё]')


def _mention_channel_username(chat):
    if getattr(chat, 'username', None):
        return chat.username
    for u in (getattr(chat, 'usernames', None) or []):
        if getattr(u, 'active', False):
            return u.username
    return None


def _mention_relevant(text):
    """Smart noise filter: keep posts with Cyrillic OR an explicit latin brand
    token (nōtem with macron / bynotem); drop foreign-language noise."""
    low = (text or '').lower()
    if not MENTION_SMART_FILTER:
        return True
    if _CYRILLIC_RE.search(low):
        return True
    return ('nōtem' in low) or ('bynotem' in low)


def _mention_snippet(text, query, n=220):
    text = re.sub(r'\s+', ' ', (text or '').strip())
    if not text:
        return ''
    if len(text) <= n:
        return text
    idx = text.lower().find(query.lstrip('@').lower())
    if idx == -1:
        return text[:n] + '…'
    start = max(0, idx - n // 3)
    end = min(len(text), start + n)
    return ('…' if start > 0 else '') + text[start:end] + ('…' if end < len(text) else '')


@app.get('/mentions', dependencies=[Depends(_serialize_stats)])
async def get_mentions(x_internal_token: str = Header(default='')):
    """Brand mentions in public channels via channels.searchPosts (Premium).
    On-demand: each query consumes one of ~10 free daily searches, so we check
    the free quota first and never spend Stars."""
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        found = {}
        queried, skipped = [], []
        quota = None
        for q in MENTION_QUERIES:
            try:
                flood = await tg(CheckSearchPostsFloodRequest(query=q))
                free = getattr(flood, 'query_is_free', False)
                remains = getattr(flood, 'remains', None)
                total = getattr(flood, 'total_daily', None)
                quota = {'remains': remains, 'total': total}
                if not (free or (remains and remains > 0)):
                    skipped.append(q)
                    continue
            except FloodWaitError:
                raise
            except Exception:
                pass   # quota check failed → try the search anyway (won't pay Stars: API errors instead)
            try:
                res = await tg(SearchPostsRequest(
                    query=q, offset_rate=0, offset_peer=InputPeerEmpty(), offset_id=0, limit=100))
            except FloodWaitError:
                raise
            except Exception as e:
                log.error(f'searchPosts «{q}»: {e}')
                skipped.append(q)
                continue
            queried.append(q)
            chats = {c.id: c for c in getattr(res, 'chats', [])}
            for msg in getattr(res, 'messages', []):
                peer = getattr(msg, 'peer_id', None)
                if not isinstance(peer, PeerChannel):
                    continue
                if not _mention_relevant(getattr(msg, 'message', None)):
                    continue
                ch = chats.get(peer.channel_id)
                uname = _mention_channel_username(ch) if ch else None
                if uname and uname.lower() in MENTION_EXCLUDE:
                    continue
                key = f'{peer.channel_id}:{msg.id}'
                if key in found:
                    continue
                date_raw = getattr(msg, 'date', None)
                found[key] = {
                    'channel_id': peer.channel_id,
                    'msg_id':     msg.id,
                    'title':      getattr(ch, 'title', 'канал') if ch else 'канал',
                    'username':   uname,
                    'link':       f'https://t.me/{uname}/{msg.id}' if uname else None,
                    'snippet':    _mention_snippet(getattr(msg, 'message', None), q),
                    'date':       date_raw.isoformat() if date_raw else None,
                    'views':      getattr(msg, 'views', 0) or 0,
                    'query':      q,
                }

        mentions = list(found.values())
        by_day, chan, total_views = {}, {}, 0
        for m in mentions:
            total_views += m['views']
            if m['date']:
                d = m['date'][8:10] + '.' + m['date'][5:7]
                by_day[d] = by_day.get(d, 0) + 1
            c = chan.setdefault(m['channel_id'],
                                {'title': m['title'], 'username': m['username'], 'count': 0, 'views': 0})
            c['count'] += 1
            c['views'] += m['views']
        top_channels = sorted(chan.values(), key=lambda c: (c['count'], c['views']), reverse=True)[:10]
        recent = sorted(mentions, key=lambda m: (m['date'] or ''), reverse=True)[:30]

        return {
            'available':       True,
            'total':           len(mentions),
            'unique_channels': len(chan),
            'total_views':     total_views,
            'by_day':          by_day,
            'top_channels':    top_channels,
            'recent':          recent,
            'all':             mentions,   # full deduped list — server persists to archive, then strips
            'quota':           quota,
            'queried':         queried,
            'skipped':         skipped,
        }
    except FloodWaitError:
        raise
    except Exception as e:
        # внешний сбой (get_client / неожиданное); пер-запросные ошибки searchPosts
        # уже обработаны внутри цикла (skip). → честный 5xx для мониторинга.
        log.error(f'mentions error: {e}')
        raise HTTPException(status_code=503, detail=str(e))


_THUMB_CACHE = OrderedDict()   # LRU: move_to_end on hit, popitem(last=False) drops the least-recently-used
_THUMB_CACHE_MAX = 500

@app.get('/thumb/{msg_id}')
async def get_thumb(msg_id: int, size: str = Query(default='sm'), x_internal_token: str = Header(default='')):
    """JPEG thumbnail of a post's media (cached). For <img> tags.
    size=lg → largest available thumbnail (sharper, used for top-post cards)."""
    check_auth(x_internal_token)
    key = f'{msg_id}:{size}'
    if key in _THUMB_CACHE:
        _THUMB_CACHE.move_to_end(key)   # mark recently used (LRU)
        return Response(content=_THUMB_CACHE[key], media_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    try:
        tg = await get_client()
        msg = await tg.get_messages(CHANNEL, ids=msg_id)
        if not msg or not (msg.photo or msg.video or msg.document):
            raise HTTPException(status_code=404, detail='no media')
        # lg: try largest available thumb first; sm: small real thumb
        indices = (-1, 2, 1, 0) if size == 'lg' else (1, 0)
        data = None
        for idx in indices:
            try:
                data = await tg.download_media(msg, thumb=idx, file=bytes)
                if data:
                    break
            except FloodWaitError:
                raise
            except Exception:
                continue
        if not data:
            raise HTTPException(status_code=404, detail='no thumbnail')
        _THUMB_CACHE[key] = data
        _THUMB_CACHE.move_to_end(key)
        while len(_THUMB_CACHE) > _THUMB_CACHE_MAX:
            _THUMB_CACHE.popitem(last=False)   # evict least-recently-used
        return Response(content=data, media_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    except (HTTPException, FloodWaitError):
        raise
    except Exception as e:
        log.error(f'get_thumb error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


_CHANNEL_PHOTO_CACHE: dict = {}   # {'jpeg': bytes} — single configured channel; cleared on restart

@app.get('/channel/photo')
async def get_channel_photo(x_internal_token: str = Header(default='')):
    """JPEG of the configured channel's profile photo (cached). For <img> tags.
    404 when the channel has no photo — the frontend then falls back to initials."""
    check_auth(x_internal_token)
    if 'jpeg' in _CHANNEL_PHOTO_CACHE:
        return Response(content=_CHANNEL_PHOTO_CACHE['jpeg'], media_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    try:
        tg = await get_client()
        data = await tg.download_profile_photo(CHANNEL, file=bytes)
        if not data:
            raise HTTPException(status_code=404, detail='no profile photo')
        _CHANNEL_PHOTO_CACHE['jpeg'] = data
        return Response(content=data, media_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    except (HTTPException, FloodWaitError):
        raise
    except Exception as e:
        log.error(f'get_channel_photo error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


# ── QR login (managed connect): capture a user session by scanning a QR ──────────
# Isolated from the global central-channel `client`: every /qr/start spins up a fresh
# ephemeral StringSession client + a background task that waits for the scan. The web
# service polls /qr/poll and, on success, receives the session string (which IT encrypts
# and stores) plus the user's admin channels. Pending logins live in memory (single
# uvicorn worker) with a short TTL. This never reads or mutates the central session.
_QR = {}                # id -> {client, qr, status, url, session, channels, tg_user_id, username, error, created, task}
_QR_TTL = 180           # seconds a pending/abandoned login stays in memory before GC
_QR_TOKEN_WAIT = 25     # wait per QR token (< Telegram's ~30s TTL) before recreating it
_QR_TOTAL = 150         # overall seconds to keep offering fresh QR tokens for one login
_QR_MAX_PENDING = 40    # cap on concurrent in-flight logins (shared-worker protection)
_QR_GC_TASK = None


async def _safe_disconnect(tg):
    try:
        if tg.is_connected():
            await tg.disconnect()
    except Exception:
        pass


async def _qr_drop(qid):
    """Remove a login: cancel its watcher task and disconnect the ephemeral client."""
    entry = _QR.pop(qid, None)
    if not entry:
        return
    task = entry.get('task')
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
    await _safe_disconnect(entry['client'])


async def _qr_gc():
    now = time.time()
    for qid in [k for k, v in list(_QR.items()) if now - v.get('created', 0) > _QR_TTL]:
        await _qr_drop(qid)


async def _qr_gc_loop():
    while True:
        await asyncio.sleep(30)
        try:
            await _qr_gc()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error(f'_qr_gc_loop: {e}')


def _is_admin_channel(e):
    """Channel-like entity (broadcast channel OR megagroup) where the user is creator/admin."""
    if not (getattr(e, 'broadcast', False) or getattr(e, 'megagroup', False)):
        return False
    return bool(getattr(e, 'creator', False) or getattr(e, 'admin_rights', None))


def _channel_info(e):
    """Enriched descriptor for the connect UI. participants_count is best-effort (often None
    from dialogs / admined-public — we deliberately do NOT spend a GetFullChannel per channel)."""
    broadcast = bool(getattr(e, 'broadcast', False))
    return {
        'id': e.id,
        'title': getattr(e, 'title', '') or '',
        'username': getattr(e, 'username', None),
        'broadcast': broadcast,
        'megagroup': bool(getattr(e, 'megagroup', False)),
        'creator': bool(getattr(e, 'creator', False)),
        'participants': getattr(e, 'participants_count', None),
        # Only broadcast channels expose stats.getBroadcastStats. Megagroups use a different
        # API we don't collect yet → the UI greys them out (eligible=False).
        'eligible': broadcast,
    }


async def _list_admin_channels(tg):
    """Channels (+ megagroups) where the logged-in user is creator or admin. Two complementary
    sources so a channel can't hide: (1) getAdminedPublicChannels catches PUBLIC channels no
    matter how stale the dialog is; (2) a full dialog scan across BOTH folders (archived=None)
    catches private ones + admin-not-creator rights. Was: iter_dialogs(limit=300) alone — a
    dormant owned channel sank below the 300 most-recent dialogs and never appeared. Bounded for
    login-completion latency (a huge dialog list still can't stall the scan)."""
    found = {}
    # 1. Public channels the user administers — recency-independent.
    try:
        res = await tg(GetAdminedPublicChannelsRequest())
        for e in (getattr(res, 'chats', None) or []):
            if _is_admin_channel(e) and e.id not in found:
                found[e.id] = _channel_info(e)
    except FloodWaitError:
        raise
    except Exception as ex:
        log.error(f'_list_admin_channels admined_public: {ex}')
    # 2. Every dialog, both the main and archived folders.
    try:
        async for d in tg.iter_dialogs(limit=1000, archived=None):
            e = d.entity
            if _is_admin_channel(e) and e.id not in found:
                found[e.id] = _channel_info(e)
    except FloodWaitError:
        raise
    except Exception as ex:
        log.error(f'_list_admin_channels dialogs: {ex}')
    # Collectable (broadcast) channels first, then the rest; stable by title.
    return sorted(found.values(), key=lambda c: (not c['eligible'], (c['title'] or '').lower()))


async def _qr_finish(entry):
    """Capture the session + identity + admin channels, then disconnect the ephemeral client."""
    tg = entry['client']
    entry['session'] = tg.session.save()
    me = await tg.get_me()
    entry['tg_user_id'] = me.id
    entry['username'] = getattr(me, 'username', None)
    entry['channels'] = await _list_admin_channels(tg)
    entry['status'] = 'ok'
    await _safe_disconnect(tg)


async def _qr_watch(qid):
    entry = _QR.get(qid)
    if not entry:
        return
    qr = entry['qr']
    deadline = time.time() + _QR_TOTAL
    try:
        while time.time() < deadline:
            try:
                await qr.wait(timeout=_QR_TOKEN_WAIT)     # scanned + confirmed
                break
            except asyncio.TimeoutError:
                try:
                    await qr.recreate()                   # token expired → mint a fresh one
                except asyncio.CancelledError:
                    raise
                except Exception:
                    entry['status'] = 'expired'
                    await _safe_disconnect(entry['client'])
                    return
                entry['url'] = qr.url                      # the poller re-renders the fresh QR
                continue
        else:
            entry['status'] = 'expired'                    # deadline reached without a scan
            await _safe_disconnect(entry['client'])
            return
    except SessionPasswordNeededError:
        entry['status'] = 'password'
        entry['created'] = time.time()                     # refresh TTL for the password window
        return
    except asyncio.CancelledError:
        raise
    except Exception as e:
        entry['status'] = 'error'
        entry['error'] = str(e)
        await _safe_disconnect(entry['client'])
        return
    try:
        await _qr_finish(entry)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        entry['status'] = 'error'
        entry['error'] = str(e)
        await _safe_disconnect(entry['client'])


@app.post('/qr/start')
async def qr_start(x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    if not API_ID or not API_HASH:
        raise HTTPException(status_code=503, detail='mtproto_not_configured')
    await _qr_gc()
    if len(_QR) >= _QR_MAX_PENDING:
        raise HTTPException(status_code=503, detail='too_many_pending')
    try:
        qid = secrets.token_urlsafe(18)
        tgc = TelegramClient(StringSession(), API_ID, API_HASH)
        await tgc.connect()
        qr = await tgc.qr_login()
        try:
            expires_in = max(1, int((qr.expires - datetime.now(timezone.utc)).total_seconds()))
        except Exception:
            expires_in = 30
        _QR[qid] = {'client': tgc, 'qr': qr, 'url': qr.url, 'status': 'pending', 'created': time.time()}
        _QR[qid]['task'] = asyncio.create_task(_qr_watch(qid))
        return {'id': qid, 'url': qr.url, 'expires_in': expires_in}
    except FloodWaitError:
        raise
    except Exception as e:
        log.error(f'qr_start: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/qr/poll')
async def qr_poll(id: str = Query(...), x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    entry = _QR.get(id)
    if not entry:
        return {'status': 'expired'}
    st = entry.get('status', 'pending')
    if st == 'ok':
        out = {'status': 'ok', 'session': entry['session'], 'channels': entry.get('channels', []),
               'tg_user_id': entry.get('tg_user_id'), 'username': entry.get('username')}
        _QR.pop(id, None)
        return out
    if st == 'error':
        err = entry.get('error', 'error')
        _QR.pop(id, None)
        return {'status': 'error', 'error': err}
    if st == 'expired':
        _QR.pop(id, None)
        return {'status': 'expired'}
    if st == 'pending':
        return {'status': 'pending', 'url': entry.get('url')}   # url rotates as tokens refresh
    return {'status': st}     # 'password'


@app.post('/qr/password')
async def qr_password(id: str = Query(...), password: str = Body(..., embed=True),
                      x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    entry = _QR.get(id)
    if not entry or entry.get('status') != 'password':
        return {'status': 'expired'}
    try:
        await entry['client'].sign_in(password=password)
    except PasswordHashInvalidError:
        return {'status': 'password', 'error': 'bad_password'}      # genuine wrong password
    except FloodWaitError:
        raise
    except Exception as e:
        log.warning(f'qr_password sign_in failed: {e}')
        await _qr_drop(id)
        return {'status': 'error', 'error': 'sign_in_failed'}       # connection/expired/etc.
    try:
        await _qr_finish(entry)
    except Exception as e:
        _QR.pop(id, None)
        return {'status': 'error', 'error': str(e)}
    out = {'status': 'ok', 'session': entry['session'], 'channels': entry.get('channels', []),
           'tg_user_id': entry.get('tg_user_id'), 'username': entry.get('username')}
    _QR.pop(id, None)
    return out


@app.post('/qr/cancel')
async def qr_cancel(id: str = Query(...), x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    await _qr_drop(id)
    return {'ok': True}


# ── Per-session collection (QR-connected channels) ───────────────────────────────
# Fetch a full dashboard bundle for ONE channel using a stored USER session, on an ephemeral client
# fully isolated from the central `client`. The daily cron calls this per QR channel and writes the
# result to Postgres (channel_snapshots + time-series), so the dashboard renders it exactly like a
# collector channel. Mirrors the central /channel · /posts · /views_summary · /stats · /graphs logic
# via the shared read helpers — the central endpoints are NOT touched. The session is sensitive
# (full account access) → it is read from the POST body and NEVER logged.

def _channel_ref(channel):
    """A stored channel reference → a Telethon-resolvable peer. Numeric ⇒ PeerChannel(id); otherwise
    a @username string (resolved via API)."""
    s = str(channel).strip()
    if s.lstrip('-').isdigit():
        return PeerChannel(int(s))
    return s.lstrip('@')


async def _resolve_channel_entity(tg, ref):
    """Resolve a channel on a freshly-connected StringSession client. A username resolves directly
    (API lookup). A bare-id PeerChannel has NO cached access_hash on a fresh StringSession, so if the
    direct lookup fails we sync dialogs once (that carries the channel's access_hash into the session
    cache) and retry — the only way to reach a PRIVATE channel by id."""
    try:
        return await tg.get_entity(ref)
    except (ValueError, TypeError):
        if isinstance(ref, PeerChannel):
            async for _ in tg.iter_dialogs(limit=1000, archived=None):
                pass
            return await tg.get_entity(ref)
        raise


def _stats_payload(stats):
    def extract(obj):
        if obj is None:
            return None
        if hasattr(obj, 'current'):
            return {'current': getattr(obj.current, 'value', obj.current),
                    'previous': getattr(obj.previous, 'value', None)}
        return obj
    return {
        'followers':             extract(getattr(stats, 'followers', None)),
        'views_per_post':        extract(getattr(stats, 'views_per_post', None)),
        'shares_per_post':       extract(getattr(stats, 'shares_per_post', None)),
        'reactions_per_post':    extract(getattr(stats, 'reactions_per_post', None)),
        'enabled_notifications': extract(getattr(stats, 'enabled_notifications', None)),
    }


async def _graphs_payload(tg, stats, points):
    top_hours = None
    th = await _resolve_graph(tg, getattr(stats, 'top_hours_graph', None))
    if th:
        x, series = _cols_of(th)
        if series:
            top_hours = {'hours': x, 'values': series[0]['values'], 'name': series[0]['name']}
    emotion = await _resolve_graph(tg, getattr(stats, 'reactions_by_emotion_graph', None))
    return {
        'available':               True,
        'growth':                  _g_timeseries(await _resolve_graph(tg, getattr(stats, 'growth_graph', None)), points),
        'followers':               _g_timeseries(await _resolve_graph(tg, getattr(stats, 'followers_graph', None)), points),
        'views_by_source':         _g_aggregate(await _resolve_graph(tg, getattr(stats, 'views_by_source_graph', None))),
        'new_followers_by_source': _g_aggregate(await _resolve_graph(tg, getattr(stats, 'new_followers_by_source_graph', None))),
        'languages':               _g_aggregate(await _resolve_graph(tg, getattr(stats, 'languages_graph', None)), top=6),
        'reactions_sentiment':     _g_aggregate(emotion),
        'reactions_daily':         _g_sum_daily(emotion),
        'interactions':            _g_timeseries(await _resolve_graph(tg, getattr(stats, 'interactions_graph', None)), points),
        'top_hours':               top_hours,
    }


async def _collect_channel(tg, entity):
    full = await tg(GetFullChannelRequest(entity))
    chat = full.chats[0]
    fc = full.full_chat
    return {
        'id':          chat.id,
        'title':       chat.title,
        'username':    getattr(chat, 'username', '') or '',
        'description': getattr(fc, 'about', '') or '',
        'members':     getattr(fc, 'participants_count', 0) or 0,
        'admins':      getattr(fc, 'admins_count', 0) or 0,
        'online':      getattr(fc, 'online_count', 0) or 0,
    }


def _views_summary_of(posts):
    total_views = total_forwards = total_reactions = total_replies = 0
    views_by_day, views_by_type = {}, {}
    for p in posts:
        v = p['views']
        total_views += v
        total_forwards += p['forwards']
        total_reactions += p['reactions']
        total_replies += p['replies']
        day = p['date'][8:10] + '.' + p['date'][5:7]   # DD.MM from ISO date
        views_by_day[day] = views_by_day.get(day, 0) + v
        views_by_type.setdefault(p['media_type'], []).append(v)
    n = len(posts)
    return {
        'total_views':       total_views,
        'total_forwards':    total_forwards,
        'total_reactions':   total_reactions,
        'total_replies':     total_replies,
        'posts_analyzed':    n,
        'avg_views':         total_views // max(n, 1),
        'avg_forwards':      total_forwards // max(n, 1),
        'views_by_day':      views_by_day,
        'avg_views_by_type': {t: int(sum(vs) / len(vs)) for t, vs in views_by_type.items() if vs},
    }


@app.post('/qr/collect')
async def qr_collect(session: str = Body(...), channel: str = Body(...),
                     posts_limit: int = Body(default=100), graph_points: int = Body(default=400),
                     x_internal_token: str = Header(default='')):
    check_auth(x_internal_token)
    if not API_ID or not API_HASH:
        raise HTTPException(status_code=503, detail='mtproto_not_configured')
    posts_limit = max(1, min(int(posts_limit or 100), 100))
    graph_points = max(1, min(int(graph_points or 400), 400))
    tg = TelegramClient(StringSession(session), API_ID, API_HASH)
    try:
        await tg.connect()
        if not await tg.is_user_authorized():
            raise HTTPException(status_code=401, detail='session_unauthorized')
        entity = await _resolve_channel_entity(tg, _channel_ref(channel))
        posts = [_build_post(g) for g in _logical_posts(await tg.get_messages(entity, limit=posts_limit))]
        # One GetBroadcastStats feeds both the KPI stats and the graphs (small channels 403 here —
        # posts/channel meta still come back, so the bundle degrades gracefully instead of failing).
        try:
            stats_obj = await tg(GetBroadcastStatsRequest(channel=entity, dark=False))
            stats_err = None
        except FloodWaitError:
            raise
        except Exception as e:
            stats_obj, stats_err = None, str(e)
        return {
            'channel':       await _collect_channel(tg, entity),
            'posts':         posts,
            'views_summary': _views_summary_of(posts),
            'stats':         _stats_payload(stats_obj) if stats_obj is not None else {'available': False, 'error': stats_err},
            'graphs':        (await _graphs_payload(tg, stats_obj, graph_points)) if stats_obj is not None else {'available': False, 'error': stats_err},
        }
    except FloodWaitError as e:
        raise HTTPException(status_code=429, detail=f'flood_wait:{getattr(e, "seconds", 0)}')
    except HTTPException:
        raise
    except Exception as e:
        log.error(f'qr_collect error (channel={channel!r}): {e}')   # NB: the session is never logged
        raise HTTPException(status_code=500, detail='collect_failed')
    finally:
        await _safe_disconnect(tg)


@app.on_event('startup')
async def startup():
    # Reap abandoned QR logins on a timer (independent of the central session below).
    global _QR_GC_TASK
    _QR_GC_TASK = asyncio.create_task(_qr_gc_loop())
    if not API_ID or not API_HASH or not SESSION:
        log.warning('TG_API_ID / TG_API_HASH / TG_SESSION не заданы — MTProto выключен')
        return
    try:
        await get_client()
        log.info(f'MTProto connected. Channel: {CHANNEL}')
    except Exception as e:
        log.error(f'MTProto startup error: {e}')


@app.on_event('shutdown')
async def shutdown():
    global client, _QR_GC_TASK
    if _QR_GC_TASK:
        _QR_GC_TASK.cancel()
    if client:
        await client.disconnect()


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=MTPROTO_PORT)
