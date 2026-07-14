# Локальный Atlavue Collector

Collector — альтернативный способ подключить Telegram без хранения пользовательской сессии в
Atlavue. `TG_SESSION`, `TG_API_HASH`, номер телефона и 2FA-пароль остаются на машине пользователя;
в SaaS отправляются только производные метрики.

Имена `PULSE_API_URL`, `PULSE_API_KEY`, каталога `.pulse-collector` и самого Python-файла пока
сохранены как совместимый технический интерфейс. Они не означают старый production-домен.

## Установка

```bash
pip install -r collector/requirements.txt
```

Создать API key collector в Atlavue, затем задать окружение:

```env
PULSE_API_URL=https://atlavue.app
PULSE_API_KEY=pa_...
TG_API_ID=123456
TG_API_HASH=...
TG_CHANNEL=@your_channel
```

## Первый вход

```bash
python collector/pulse_collector.py login
```

Collector покажет QR-код. В Telegram открыть **Настройки -> Устройства -> Подключить устройство**
и отсканировать его. При включённой 2FA пароль запрашивается один раз.

Сессия сохраняется в `~/.pulse-collector/session.txt` с правами `600`. Можно передать существующую
`TG_SESSION` через окружение, но обычному пользователю это не требуется.

## Команды

```bash
python collector/pulse_collector.py doctor  # проверить окружение и соединения
python collector/pulse_collector.py once    # собрать и отправить один раз
python collector/pulse_collector.py run     # повторять каждые 6 часов
python collector/pulse_collector.py flush   # повторить неуспешные доставки
```

Интервал меняется через `COLLECT_INTERVAL_SECONDS`, но не может быть меньше 15 минут. Неуспешные
доставки остаются в `~/.pulse-collector/queue.sqlite3` и повторяются с exponential backoff.

Поиск упоминаний по умолчанию выключен из-за квоты Telegram `searchPosts`. Включать только явно:

```bash
python collector/pulse_collector.py once --mentions
```

Для постоянного режима можно задать `COLLECT_MENTIONS=1`, понимая стоимость квоты.
