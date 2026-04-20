# Pulse Analytics — Инструкция по запуску

## Структура проекта

```
pulse-analytics/
├── server/
│   └── index.js          ← Node.js бэкенд (Express)
├── public/
│   └── index.html        ← Фронтенд (отдаётся сервером)
├── package.json
├── .env.example          ← Скопируй в .env и заполни
└── README.md
```

---

## 🚀 Быстрый старт (локально)

```bash
# 1. Установи зависимости
npm install

# 2. Создай .env файл
cp .env.example .env

# 3. Заполни .env своими данными (см. ниже)
nano .env   # или открой в редакторе

# 4. Запусти сервер
npm start

# Открой: http://localhost:3000
```

---

## ⚙️ Настройка .env

```env
PORT=3000
TEAM_PASSWORD=придумай_пароль       # команда будет вводить его при входе

# Instagram (Meta Graph API)
IG_ACCESS_TOKEN=EAAxxxxxxxxxx       # из developers.facebook.com/tools/explorer
IG_ACCOUNT_ID=17841400000000000     # ID Instagram Business аккаунта

# Telegram (Bot API)
TG_BOT_TOKEN=1234567890:ABCD...     # от @BotFather
TG_CHANNEL=@your_channel            # username канала с @
```

### Получить Instagram токен:
1. Зайди на https://developers.facebook.com/tools/explorer
2. Выбери приложение → выдай права: `instagram_basic`, `instagram_manage_insights`, `pages_show_list`
3. Нажми "Generate Access Token"
4. Скопируй токен в `IG_ACCESS_TOKEN`
5. Для получения `IG_ACCOUNT_ID`: `GET /me/accounts?fields=instagram_business_account`

### Получить Telegram токен:
1. Напиши @BotFather → /newbot → следуй инструкциям
2. Скопируй токен в `TG_BOT_TOKEN`
3. Добавь бота в канал как **администратора**

---

## ☁️ Деплой на Railway (рекомендуется, бесплатно)

**Railway** — самый простой способ. Бесплатный план: 500 часов/мес.

```bash
# 1. Установи Railway CLI
npm install -g @railway/cli

# 2. Войди
railway login

# 3. Создай проект
railway init

# 4. Деплой
railway up

# 5. Добавь переменные окружения
railway variables set TEAM_PASSWORD=твой_пароль
railway variables set IG_ACCESS_TOKEN=EAAxxxxxxx
railway variables set IG_ACCOUNT_ID=178414xxxxx
railway variables set TG_BOT_TOKEN=123456:ABCDxxx
railway variables set TG_CHANNEL=@твой_канал

# 6. Получи URL
railway domain
```

Или через UI: https://railway.app → New Project → Deploy from GitHub

---

## ☁️ Деплой на Render (альтернатива)

1. Зайди на https://render.com → New Web Service
2. Подключи GitHub репо
3. Settings:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Environment Variables → добавь все из `.env`
5. Нажми Deploy

Бесплатный план доступен, но засыпает после 15 минут неактивности.

---

## ☁️ Деплой на VPS (самостоятельно)

```bash
# На сервере (Ubuntu/Debian):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Клонируй репо
git clone <твой-репо> pulse-analytics
cd pulse-analytics
npm install

# Создай .env
nano .env

# Запуск через PM2 (автоперезапуск)
npm install -g pm2
pm2 start server/index.js --name pulse
pm2 save
pm2 startup

# Сервер работает на порту 3000
# Настрой nginx как reverse proxy если нужен домен + HTTPS
```

---

## 🔒 Безопасность

- Токены хранятся **только на сервере** в `.env` — команда их не видит
- Авторизация через пароль → сессионный токен (8 часов)
- Rate limiting: 100 запросов / 15 минут
- Кэш API ответов: 10 минут (снижает нагрузку на Instagram/Telegram API)

---

## 📡 API эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| `POST` | `/api/auth/login` | Вход (пароль → токен) |
| `GET` | `/api/auth/check` | Проверка сессии |
| `POST` | `/api/auth/logout` | Выход |
| `GET` | `/api/ig/profile` | Профиль Instagram |
| `GET` | `/api/ig/insights?days=30` | Метрики аккаунта |
| `GET` | `/api/ig/posts?limit=20` | Посты с инсайтами |
| `GET` | `/api/tg/channel` | Информация о канале |
| `GET` | `/api/tg/stats` | Статистика канала |
| `GET` | `/api/health` | Статус сервера |
| `DELETE` | `/api/cache` | Сброс кэша |

---

## ⚠️ Ограничения Telegram Bot API

Bot API (бесплатный) даёт: число подписчиков, информацию о канале.

Для полной аналитики (просмотры, репосты, реакции) нужен **Telegram MTProto API** через библиотеку Telethon (Python). Это требует регистрации приложения на https://my.telegram.org. Напиши если нужно — добавим Python микросервис.

---

## 🔄 Обновление токена Instagram

Токен живёт 60 дней. Для автообновления добавь в `.env`:
```
IG_APP_ID=ваш_app_id
IG_APP_SECRET=ваш_app_secret
```
И добавь в сервер cron-задачу на обновление через `/oauth/access_token`.
