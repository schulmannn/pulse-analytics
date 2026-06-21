"""
Pulse Analytics — MTProto микросервис
Python + Telethon + FastAPI
"""

import asyncio
import os
import json
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, Query, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.stats import GetBroadcastStatsRequest, LoadAsyncGraphRequest
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


async def get_client() -> TelegramClient:
    global client
    if client and client.is_connected():
        return client
    if not SESSION:
        raise RuntimeError('TG_SESSION не задан — добавь строку сессии в переменные окружения')
    client = TelegramClient(StringSession(SESSION), API_ID, API_HASH)
    await client.connect()
    if not await client.is_user_authorized():
        raise RuntimeError('TG_SESSION недействителен или истёк — сгенерируй заново')
    log.info('Telethon client connected (StringSession)')
    return client


def check_auth(x_internal_token: str = Header(default='')):
    if TEAM_PASS and x_internal_token != TEAM_PASS:
        raise HTTPException(status_code=401, detail='Unauthorized')


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

        posts = []
        for msg in messages:
            if not msg or msg.action:
                continue

            reactions_detail = []
            reactions_total = 0
            if msg.reactions and msg.reactions.results:
                for r in msg.reactions.results:
                    emoji = getattr(r.reaction, 'emoticon', '?')
                    reactions_detail.append({'emoji': emoji, 'count': r.count})
                    reactions_total += r.count

            media_type = 'text'
            if msg.photo:         media_type = 'photo'
            elif msg.video:       media_type = 'video'
            elif msg.document:    media_type = 'document'
            elif msg.poll:        media_type = 'poll'
            elif msg.audio:       media_type = 'audio'
            elif msg.voice:       media_type = 'voice'
            elif msg.web_preview: media_type = 'link'

            posts.append({
                'id':               msg.id,
                'date':             msg.date.isoformat(),
                'text':             (msg.text or msg.message or '')[:200],
                'views':            msg.views or 0,
                'forwards':         msg.forwards or 0,
                'replies':          getattr(msg.replies, 'replies', 0) if msg.replies else 0,
                'reactions':        reactions_total,
                'reactions_detail': reactions_detail,
                'media_type':       media_type,
                'pinned':           msg.pinned or False,
            })

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

        total_views = 0
        total_forwards = 0
        total_reactions = 0
        total_replies = 0
        views_by_day = {}
        views_by_type = {}

        for msg in msgs:
            if not msg or msg.action:
                continue

            v = msg.views or 0
            f = msg.forwards or 0
            r = sum(x.count for x in (msg.reactions.results if msg.reactions else []))
            rep = getattr(msg.replies, 'replies', 0) if msg.replies else 0

            total_views += v
            total_forwards += f
            total_reactions += r
            total_replies += rep

            day = msg.date.strftime('%d.%m')
            views_by_day[day] = views_by_day.get(day, 0) + v

            mtype = 'text'
            if msg.photo:      mtype = 'photo'
            elif msg.video:    mtype = 'video'
            elif msg.poll:     mtype = 'poll'
            elif msg.document: mtype = 'document'

            if mtype not in views_by_type:
                views_by_type[mtype] = []
            views_by_type[mtype].append(v)

        avg_by_type = {
            t: int(sum(vs) / len(vs))
            for t, vs in views_by_type.items() if vs
        }

        return {
            'total_views':       total_views,
            'total_forwards':    total_forwards,
            'total_reactions':   total_reactions,
            'total_replies':     total_replies,
            'posts_analyzed':    limit,
            'avg_views':         total_views // max(limit, 1),
            'avg_forwards':      total_forwards // max(limit, 1),
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

        top_hours = None
        th = await resolve(getattr(stats, 'top_hours_graph', None))
        if th:
            x, series = cols_of(th)
            if series:
                top_hours = {'hours': x, 'values': series[0]['values'], 'name': series[0]['name']}

        return {
            'available':                True,
            'growth':                   timeseries(await resolve(getattr(stats, 'growth_graph', None))),
            'followers':                timeseries(await resolve(getattr(stats, 'followers_graph', None))),
            'views_by_source':          aggregate(await resolve(getattr(stats, 'views_by_source_graph', None))),
            'new_followers_by_source':  aggregate(await resolve(getattr(stats, 'new_followers_by_source_graph', None))),
            'languages':                aggregate(await resolve(getattr(stats, 'languages_graph', None)), top=6),
            'reactions_sentiment':      aggregate(await resolve(getattr(stats, 'reactions_by_emotion_graph', None))),
            'top_hours':                top_hours,
        }
    except Exception as e:
        log.error(f'get_graphs error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


_THUMB_CACHE = {}

@app.get('/thumb/{msg_id}')
async def get_thumb(msg_id: int, x_internal_token: str = Header(default='')):
    """Small JPEG thumbnail of a post's media (cached). For <img> tags."""
    check_auth(x_internal_token)
    if msg_id in _THUMB_CACHE:
        return Response(content=_THUMB_CACHE[msg_id], media_type='image/jpeg',
                        headers={'Cache-Control': 'public, max-age=86400'})
    try:
        tg = await get_client()
        msg = await tg.get_messages(CHANNEL, ids=msg_id)
        if not msg or not (msg.photo or msg.video or msg.document):
            raise HTTPException(status_code=404, detail='no media')
        data = None
        for idx in (1, 0):          # idx 1 ≈ small real thumb; idx 0 = tiny fallback
            try:
                data = await tg.download_media(msg, thumb=idx, file=bytes)
                if data:
                    break
            except Exception:
                continue
        if not data:
            raise HTTPException(status_code=404, detail='no thumbnail')
        _THUMB_CACHE[msg_id] = data
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
