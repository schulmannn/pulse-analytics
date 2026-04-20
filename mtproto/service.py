"""
Pulse Analytics — MTProto микросервис
Python + Telethon + FastAPI

Даёт реальные данные которые Bot API не отдаёт:
  - просмотры каждого поста
  - реакции (детально по эмодзи)
  - репосты / forwards
  - история постов (любая глубина)
  - статистика канала (только для больших каналов 500+)

Запуск:
  pip install -r requirements.txt
  python mtproto/service.py
"""

import asyncio
import os
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Header, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from telethon import TelegramClient
from telethon.tl.functions.stats import GetBroadcastStatsRequest
from telethon.tl.functions.channels import GetFullChannelRequest
from telethon.tl.types import Channel
from dotenv import load_dotenv

load_dotenv()
# Восстанавливаем сессию из переменной окружения
_session_b64 = os.getenv('TG_SESSION_B64', '')
if _session_b64:
    import base64
    with open('pulse.session', 'wb') as _f:
        _f.write(base64.b64decode(_session_b64 + '=='))
    log.info('Session restored from TG_SESSION_B64')

# ── Logging ──────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────
API_ID      = int(os.getenv('TG_API_ID', '0'))
API_HASH    = os.getenv('TG_API_HASH', '')
PHONE       = os.getenv('TG_PHONE', '')          # +79001234567
SESSION     = os.getenv('TG_SESSION', 'pulse')   # имя файла сессии
CHANNEL     = os.getenv('TG_CHANNEL', '')        # @channel или -1001234567890
TEAM_PASS   = os.getenv('TEAM_PASSWORD', '')
MTPROTO_PORT = int(os.getenv('MTPROTO_PORT', '8001'))

# ── FastAPI ──────────────────────────────────────────────
app = FastAPI(title='Pulse MTProto Service', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],   # Node.js бэкенд обращается локально
    allow_methods=['GET'],
    allow_headers=['*'],
)

# ── Telethon client (singleton) ──────────────────────────
client: Optional[TelegramClient] = None

async def get_client() -> TelegramClient:
    global client
    if client and client.is_connected():
        return client
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start(phone=PHONE)
    log.info('Telethon client connected')
    return client


# ── Auth guard ───────────────────────────────────────────
def check_auth(x_internal_token: str = Header(default='')):
    """Простая защита: Node.js передаёт внутренний токен."""
    if TEAM_PASS and x_internal_token != TEAM_PASS:
        raise HTTPException(status_code=401, detail='Unauthorized')


# ══════════════════════════════════════════════════════════
#  ENDPOINTS
# ══════════════════════════════════════════════════════════

@app.get('/health')
async def health():
    """Проверка что сервис жив."""
    return {
        'status': 'ok',
        'connected': client.is_connected() if client else False,
        'channel': CHANNEL,
    }


@app.get('/channel')
async def get_channel(x_internal_token: str = Header(default='')):
    """Полная информация о канале через MTProto."""
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)
        full   = await tg(GetFullChannelRequest(entity))

        chat = full.chats[0]
        fc   = full.full_chat

        return {
            'id':           chat.id,
            'title':        chat.title,
            'username':     getattr(chat, 'username', ''),
            'description':  getattr(fc, 'about', ''),
            'members':      getattr(fc, 'participants_count', 0),
            'admins':       getattr(fc, 'admins_count', 0),
            'banned':       getattr(fc, 'banned_count', 0),
            'online':       getattr(fc, 'online_count', 0),
            'linked_chat':  getattr(fc, 'linked_chat_id', None),
            'invite_link':  getattr(fc, 'invite_link', ''),
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
    """
    Реальные посты с просмотрами, реакциями и репостами.
    limit  — сколько постов взять (макс 100)
    offset_id — ID поста с которого начинать (для пагинации)
    """
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        messages = await tg.get_messages(CHANNEL, limit=limit, offset_id=offset_id or 0)

        posts = []
        for msg in messages:
            if not msg or msg.action:   # пропускаем системные сообщения
                continue

            # Реакции — детально по каждому эмодзи
            reactions_detail = []
            reactions_total  = 0
            if msg.reactions and msg.reactions.results:
                for r in msg.reactions.results:
                    emoji = getattr(r.reaction, 'emoticon', '?')
                    count = r.count
                    reactions_detail.append({'emoji': emoji, 'count': count})
                    reactions_total += count

            # Тип медиа
            media_type = 'text'
            if msg.photo:                  media_type = 'photo'
            elif msg.video:                media_type = 'video'
            elif msg.document:             media_type = 'document'
            elif msg.poll:                 media_type = 'poll'
            elif msg.audio:                media_type = 'audio'
            elif msg.voice:                media_type = 'voice'
            elif msg.sticker:              media_type = 'sticker'
            elif msg.web_preview:          media_type = 'link'

            posts.append({
                'id':            msg.id,
                'date':          msg.date.isoformat(),
                'text':          (msg.text or msg.message or '')[:200],
                'views':         msg.views or 0,       # ← РЕАЛЬНЫЕ просмотры!
                'forwards':      msg.forwards or 0,    # ← РЕАЛЬНЫЕ репосты!
                'replies':       getattr(msg.replies, 'replies', 0) if msg.replies else 0,
                'reactions':     reactions_total,
                'reactions_detail': reactions_detail,
                'media_type':    media_type,
                'pinned':        msg.pinned or False,
                'post_author':   msg.post_author or '',
                'edit_date':     msg.edit_date.isoformat() if msg.edit_date else None,
            })

        return {
            'posts': posts,
            'count': len(posts),
            'channel': CHANNEL,
        }

    except Exception as e:
        log.error(f'get_posts error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/stats')
async def get_stats(x_internal_token: str = Header(default='')):
    """
    Нативная статистика Telegram (только для каналов с 500+ подписчиков
    у которых включена статистика в настройках).
    Возвращает: рост подписчиков, просмотры, ERR%, источники.
    """
    check_auth(x_internal_token)
    try:
        tg = await get_client()
        entity = await tg.get_entity(CHANNEL)

        stats = await tg(GetBroadcastStatsRequest(
            channel=entity,
            dark=False   # True = тёмная тема в графиках (не влияет на данные)
        ))

        def extract_range(obj):
            """Достаём min/max из StatsAbsValueAndPrev или просто число."""
            if obj is None:
                return None
            if hasattr(obj, 'current'):
                return {
                    'current': getattr(obj.current, 'value', obj.current),
                    'previous': getattr(obj.previous, 'value', getattr(obj, 'previous', None)),
                }
            return obj

        return {
            'followers':        extract_range(getattr(stats, 'followers', None)),
            'views_per_post':   extract_range(getattr(stats, 'views_per_post', None)),
            'shares_per_post':  extract_range(getattr(stats, 'shares_per_post', None)),
            'reactions_per_post': extract_range(getattr(stats, 'reactions_per_post', None)),
            'enabled_notifications': extract_range(getattr(stats, 'enabled_notifications', None)),
            'raw': str(stats)[:500],  # первые 500 символов raw для дебага
        }

    except Exception as e:
        err = str(e)
        log.error(f'get_stats error: {err}')
        if 'BROADCAST_PUBLIC_VOTERS_REQUIRED' in err or 'CHANNEL_PRIVATE' in err:
            raise HTTPException(
                status_code=403,
                detail='Статистика недоступна: канал должен быть публичным и иметь 500+ подписчиков'
            )
        raise HTTPException(status_code=500, detail=err)


@app.get('/views_summary')
async def get_views_summary(
    limit: int = Query(default=30, le=100),
    x_internal_token: str = Header(default=''),
):
    """
    Сводка по просмотрам — быстрый эндпоинт для дашборда.
    Возвращает агрегированные метрики без полного текста постов.
    """
    check_auth(x_internal_token)
    try:
        tg     = await get_client()
        msgs   = await tg.get_messages(CHANNEL, limit=limit)

        total_views    = 0
        total_forwards = 0
        total_reactions= 0
        total_replies  = 0
        views_by_day   = {}  # date_str → views
        views_by_type  = {}  # media_type → [views]

        for msg in msgs:
            if not msg or msg.action:
                continue

            v = msg.views or 0
            f = msg.forwards or 0
            r = sum(x.count for x in (msg.reactions.results if msg.reactions else []))
            rep = getattr(msg.replies, 'replies', 0) if msg.replies else 0

            total_views     += v
            total_forwards  += f
            total_reactions += r
            total_replies   += rep

            # По дням
            day = msg.date.strftime('%d.%m')
            views_by_day[day] = views_by_day.get(day, 0) + v

            # По типу
            mtype = 'text'
            if msg.photo:    mtype = 'photo'
            elif msg.video:  mtype = 'video'
            elif msg.poll:   mtype = 'poll'
            elif msg.document: mtype = 'document'

            if mtype not in views_by_type:
                views_by_type[mtype] = []
            views_by_type[mtype].append(v)

        # Средние просмотры по типу
        avg_by_type = {
            t: int(sum(vs) / len(vs)) for t, vs in views_by_type.items() if vs
        }

        return {
            'total_views':     total_views,
            'total_forwards':  total_forwards,
            'total_reactions': total_reactions,
            'total_replies':   total_replies,
            'posts_analyzed':  limit,
            'avg_views':       total_views // max(limit, 1),
            'avg_forwards':    total_forwards // max(limit, 1),
            'views_by_day':    views_by_day,
            'avg_views_by_type': avg_by_type,
        }

    except Exception as e:
        log.error(f'views_summary error: {e}')
        raise HTTPException(status_code=500, detail=str(e))


# ══════════════════════════════════════════════════════════
#  STARTUP / SHUTDOWN
# ══════════════════════════════════════════════════════════

@app.on_event('startup')
async def startup():
    if not API_ID or not API_HASH:
        log.warning('TG_API_ID / TG_API_HASH не заданы — MTProto отключён')
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
        log.info('Telethon disconnected')


if __name__ == '__main__':
    uvicorn.run('service:app', host='0.0.0.0', port=MTPROTO_PORT, reload=False)
