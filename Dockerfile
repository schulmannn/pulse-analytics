# Pulse Analytics — LEGACY одно-контейнерная сборка (два процесса в одном образе).
# Оставлена для локальной разработки и zero-downtime миграции на сплит.
# ПРОД переезжает на ДВА Railway-сервиса: Dockerfile.web (Node) + Dockerfile.mtproto
# (Python), связанные приватной сетью. Этот файл можно удалить после катовера.
#
# Один контейнер запускает СРАЗУ два процесса:
#   • Node/Express (server/index.js) → отдаёт дашборд + API на Railway $PORT (публично)
#   • Python/FastAPI + Telethon (mtproto/service.py) → внутренний MTProto на :8001,
#     Node ходит к нему через MTPROTO_URL (по умолчанию http://localhost:8001)
FROM node:20-slim

ENV PYTHONUNBUFFERED=1 \
    NODE_ENV=production

# Python для MTProto-микросервиса
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node-зависимости (lock-файла нет → обычный install)
COPY package.json ./
RUN npm install --omit=dev

# Python-зависимости (внутри контейнера PEP668 обходим --break-system-packages)
COPY mtproto/requirements.txt ./mtproto/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r mtproto/requirements.txt

# Исходники приложения
COPY . .

# MTProto в фоне на :8001, затем веб-сервер на $PORT.
# Если MTProto не поднимется — сайт всё равно работает (аналитика деградирует мягко).
CMD ["sh", "-c", "python3 mtproto/service.py & exec node server/index.js"]
