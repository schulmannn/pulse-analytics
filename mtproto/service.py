"""
Pulse Analytics — MTProto микросервис
Python + Telethon + FastAPI
"""

import asyncio
import os
import json
import logging
import re
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, Query, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.stats import GetBroadcastStatsRequest, LoadAsyncGraphRequest, GetMessageStatsRequest
from telethon.tl.functions.channels import GetFullChannelRequest
from telethon.tl.types import StatsGraph, StatsGraphAsync
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
TEAM_PASS    = os.getenv('TEAM_PASSWORD', '')
MTPROTO_PORT = int(os.getenv('MTPROTO_PORT', '8001'))

# ── FastAPI ──────────────────────────────────────────────
app = FastAPI(title='Pulse MTProto Service', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['GET'],
    allow_headers=['*'],
)

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
    if TEAM_PASS and x_internal_token != TEAM_PASS:
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


@app.get('/health')
async def health():
    return {
        'status': 'ok',
        'connected': client.is_connected() if client else False,
        'channel': CHANNEL,
    }


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

    except Exception as e:
        log.error(f'get_posts error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/views_summary')
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

    except Exception as e:
        log.error(f'views_summary error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/stats')
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

    except Exception as e:
        return {'available': False, 'error': str(e)}


@app.get('/graphs')
async def get_graphs(x_internal_token: str = Header(default='')):
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
            'growth':                   timeseries(await resolve(getattr(stats, 'growth_graph', None))),
            'followers':                timeseries(await resolve(getattr(stats, 'followers_graph', None))),
            'views_by_source':          aggregate(await resolve(getattr(stats, 'views_by_source_graph', None))),
            'new_followers_by_source':  aggregate(await resolve(getattr(stats, 'new_followers_by_source_graph', None))),
            'languages':                aggregate(await resolve(getattr(stats, 'languages_graph', None)), top=6),
            'reactions_sentiment':      aggregate(emotion),
            'reactions_daily':          sum_daily(emotion),
            'interactions':             timeseries(await resolve(getattr(stats, 'interactions_graph', None))),
            'top_hours':                top_hours,
        }
    except Exception as e:
        log.error(f'get_graphs error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/post_stats/{msg_id}')
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
    except Exception as e:
        log.error(f'get_post_stats error: {e}')
        return {'available': False, 'error': str(e)}


_THUMB_CACHE = {}
_THUMB_CACHE_MAX = 500

@app.get('/thumb/{msg_id}')
async def get_thumb(msg_id: int, size: str = Query(default='sm'), x_internal_token: str = Header(default='')):
    """JPEG thumbnail of a post's media (cached). For <img> tags.
    size=lg → largest available thumbnail (sharper, used for top-post cards)."""
    check_auth(x_internal_token)
    key = f'{msg_id}:{size}'
    if key in _THUMB_CACHE:
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
            except Exception:
                continue
        if not data:
            raise HTTPException(status_code=404, detail='no thumbnail')
        if len(_THUMB_CACHE) >= _THUMB_CACHE_MAX:
            _THUMB_CACHE.pop(next(iter(_THUMB_CACHE)), None)
        _THUMB_CACHE[key] = data
        return Response(content=data, media_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    except HTTPException:
        raise
    except Exception as e:
        log.error(f'get_thumb error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.on_event('startup')
async def startup():
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
    global client
    if client:
        await client.disconnect()


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=MTPROTO_PORT)
