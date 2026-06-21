# Pulse Analytics

Дашборд аналитики Telegram-канала (+ задел под Instagram). Данные по Telegram
тянутся **через твой личный профиль по MTProto** (Telethon) — это даёт куда
больше, чем Bot API: просмотры, репосты, реакции, комментарии и статистику
канала (рост подписчиков, источники просмотров/подписчиков, активность по часам,
языки аудитории, тональность реакций и т.д.).

## Архитектура

Один контейнер запускает **два процесса**:

```
pulse-analytics/
├── server/index.js     ← Node/Express: отдаёт дашборд + API на публичном $PORT,
│                          проксирует /api/tg/mtproto/* на Python-сервис
├── public/index.html   ← фронтенд (vanilla JS, inline-SVG графики, без CDN)
├── mtproto/
│   ├── service.py       ← Python/FastAPI + Telethon (MTProto) на внутреннем :8001
│   └── requirements.txt
├── Dockerfile          ← собирает Node + Python в один образ
└── package.json
```

`Dockerfile` CMD: `python3 mtproto/service.py & exec node server/index.js`.
Node ходит к Python по `MTPROTO_URL` (по умолчанию `http://localhost:8001`).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `TEAM_PASSWORD` | пароль для входа команды (он же секрет подписи stateless-токенов) |
| `TG_API_ID` / `TG_API_HASH` | приложение Telegram с my.telegram.org (та же пара, которой создавалась сессия) |
| `TG_SESSION` | **StringSession** твоего аккаунта (см. ниже) |
| `TG_CHANNEL` | канал, напр. `@bynotem` |
| `MTPROTO_PORT` | внутренний порт Python-сервиса (по умолчанию `8001`) |
| `PORT` | порт Node (на Railway выставить `8080` и навести домен на него) |
| `TG_BOT_TOKEN` | *опционально* — Bot API как резерв; MTProto работает и без него |
| `IG_ACCESS_TOKEN` / `IG_ACCOUNT_ID` | *опционально* — Instagram (пока не используется) |

### Как получить `TG_SESSION` (один раз, локально)

```python
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
api_id, api_hash = 12345, "xxxx"
with TelegramClient(StringSession(), api_id, api_hash) as c:
    print(c.session.save())   # вставь результат в TG_SESSION
```

Введёшь телефон и код из Telegram. Строка = полный доступ к аккаунту, **храни в
секрете, не коммить**.

## Запуск локально

```bash
npm install
pip install -r mtproto/requirements.txt
# выставь переменные окружения (например через .env + dotenv)
python3 mtproto/service.py &     # MTProto на :8001
npm start                        # сайт на http://localhost:3000
```

## Деплой на Railway

1. New Project → Deploy from GitHub → этот репозиторий.
2. **Settings → Root Directory: пусто** (чтобы собирался корневой `Dockerfile`,
   а не папка `mtproto`). **Custom Start Command: пусто** (используется CMD из Dockerfile).
3. **Variables:** задать переменные из таблицы выше (`PORT=8080`).
4. **Networking:** домен → target port **8080** (порт Node).
5. Пуш в `main` → автодеплой.

## ⚠️ Важно: версия Telethon

`telethon` должен быть **>= 1.43.2**. Старые версии (напр. 1.36.0) не парсят
текущий TL-layer Telegram и падают на `get_entity`/`get_messages` с
*"Could not find a matching Constructor ID"* — канал и посты приходят пустыми
(хотя статистика-графики при этом работают). Если посты/просмотры внезапно `0` —
проверь версию Telethon первым делом.

## API

| Метод | URL | Описание |
|---|---|---|
| `POST` | `/api/auth/login` | вход (пароль → stateless-токен на 8 ч) |
| `GET` | `/api/auth/check` | проверка сессии |
| `GET` | `/api/tg/channel` | инфо о канале (bot API → фолбэк на MTProto) |
| `GET` | `/api/tg/full?limit=N` | агрегат: канал + views_summary + посты |
| `GET` | `/api/tg/mtproto/stats` | GetBroadcastStats (скаляры) |
| `GET` | `/api/tg/mtproto/graphs` | нормализованные графики статистики |
| `GET` | `/api/tg/mtproto/thumb/:id` | превью медиа поста (image/jpeg) |
| `GET` | `/api/health` | статус |

## Безопасность

- Токены/сессия — только в переменных окружения, не в коде.
- Авторизация: stateless HMAC-токен (подписан `TEAM_PASSWORD`), переживает рестарт.
- Rate limiting на `/api/`, кэш ответов ~10 минут.
- `/api/tg/mtproto/thumb/:id` — открытый роут (img-теги не шлют заголовки), отдаёт
  только превью постов настроенного (публичного) канала.
