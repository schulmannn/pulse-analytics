(function () {
  'use strict';

  window.createCollectorSettings = function createCollectorSettings(deps) {
    const { API, getChannels, escapeHtml, toast, reloadChannels } = deps;

    async function statusLine(channelId) {
      try {
        const result = await API.req('/api/channels/' + channelId + '/collector-status');
        const status = result && result.status;
        if (!status) return '<span style="color:var(--color-ghost-gray)">данных ещё нет</span>';
        if (status.last_error) {
          return `<span style="color:var(--color-vibrant-orange)">ошибка: ${escapeHtml(status.last_error)}</span>`;
        }
        if (status.stale) {
          return `<span style="color:var(--color-vibrant-orange)">collector не присылал данные больше ${escapeHtml(status.stale_after_hours)} ч.</span>`;
        }
        return `<span style="color:var(--color-ghost-gray)">последний ingest: ${escapeHtml(status.last_success_at || '—')} · collector ${escapeHtml(status.collector_version || '—')}</span>`;
      } catch (_) {
        return '<span style="color:var(--color-ghost-gray)">статус недоступен</span>';
      }
    }

    async function render() {
      const list = document.getElementById('channels-list');
      if (!list) return;
      const channels = getChannels() || [];
      if (!channels.length) {
        list.innerHTML = '<div style="color:var(--color-ghost-gray);font-size:var(--text-caption);padding:6px 0">Каналов пока нет — добавь свой ниже.</div>';
        return;
      }
      list.innerHTML = channels.map(channel => {
        const name = escapeHtml('@' + (channel.username || channel.title || channel.id));
        const controls = channel.source === 'central'
          ? '<span class="tag" style="font-size:11px">central</span>'
          : `<button class="btn-outline sm js-key" data-cid="${channel.id}">API-ключ</button> <button class="btn-outline sm js-del" data-cid="${channel.id}" title="Удалить канал">✕</button>`;
        return `<div style="border-top:1px solid var(--color-powder-blue);padding:8px 0">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><b>${name}</b><span style="display:flex;gap:6px;white-space:nowrap">${controls}</span></div>
          <div class="js-collector-status" data-cid="${channel.id}" style="font-size:11px;margin-top:3px"></div>
          <div class="js-keys" data-cid="${channel.id}" style="margin-top:6px"></div>
        </div>`;
      }).join('');
      list.querySelectorAll('.js-key').forEach(button => {
        button.onclick = () => showKeys(+button.dataset.cid);
      });
      list.querySelectorAll('.js-del').forEach(button => {
        button.onclick = () => removeChannel(+button.dataset.cid);
      });
      for (const channel of channels.filter(item => item.source !== 'central')) {
        const element = list.querySelector(`.js-collector-status[data-cid="${channel.id}"]`);
        if (element) element.innerHTML = await statusLine(channel.id);
      }
    }

    async function showKeys(channelId) {
      const box = document.querySelector(`.js-keys[data-cid="${channelId}"]`);
      if (!box) return;
      box.innerHTML = 'Загрузка…';
      try {
        const result = await API.req('/api/channels/' + channelId + '/keys');
        const keys = (result && result.keys) || [];
        box.innerHTML = keys.map(key =>
          `<div style="font-size:var(--text-caption);display:flex;justify-content:space-between;gap:8px;padding:2px 0">
            <code>${escapeHtml(key.key_prefix)}…</code>
            <span>${key.revoked ? '<span style="color:var(--color-ghost-gray)">отозван</span>' : `<a class="js-revoke" data-kid="${key.id}" style="cursor:pointer;color:var(--color-vibrant-orange)">отозвать</a>`}</span>
          </div>`).join('') +
          '<button class="btn-primary sm js-newkey" style="margin-top:6px">Создать ключ</button>';
        box.querySelectorAll('.js-revoke').forEach(link => {
          link.onclick = async () => {
            try {
              await API.req('/api/channels/' + channelId + '/key/' + link.dataset.kid, { method: 'DELETE' });
              await showKeys(channelId);
            } catch (error) {
              toast(error.message, 'error');
            }
          };
        });
        box.querySelector('.js-newkey').onclick = () => createKey(channelId);
      } catch (error) {
        box.innerHTML = '<span style="color:var(--color-vibrant-orange)">' + escapeHtml(error.message) + '</span>';
      }
    }

    async function createKey(channelId) {
      const box = document.querySelector(`.js-keys[data-cid="${channelId}"]`);
      try {
        const result = await API.req('/api/channels/' + channelId + '/key', {
          method: 'POST',
          body: JSON.stringify({ label: 'local collector' }),
        });
        const ingestUrl = location.origin + '/api/collector/ingest';
        box.innerHTML = `<div style="background:var(--color-porcelain);border:1px solid var(--color-powder-blue);border-radius:6px;padding:10px;font-size:var(--text-caption)">
          <div style="color:var(--color-vibrant-orange);font-weight:600">Скопируй ключ — он показывается один раз:</div>
          <code class="js-created-key" style="word-break:break-all;display:block;margin:6px 0">${escapeHtml(result.key)}</code>
          <button class="btn-outline sm js-copy">Копировать</button>
          <div style="margin-top:8px;color:var(--color-ghost-gray)">Collector шлёт метрики на <code>${escapeHtml(ingestUrl)}</code>. Перед первым запуском выполни <code>python collector/pulse_collector.py doctor</code>.</div>
        </div>`;
        box.querySelector('.js-copy').onclick = () => {
          const value = box.querySelector('.js-created-key').textContent || '';
          if (navigator.clipboard) navigator.clipboard.writeText(value).then(() => toast('Скопировано', 'info'));
        };
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    async function removeChannel(channelId) {
      if (!window.confirm('Удалить канал и все его данные? Это необратимо.')) return;
      try {
        await API.req('/api/channels/' + channelId, { method: 'DELETE' });
        await reloadChannels();
        await render();
      } catch (error) {
        toast(error.message, 'error');
      }
    }

    function bindAddForm() {
      document.getElementById('add-channel-form')?.addEventListener('submit', async event => {
        event.preventDefault();
        const input = document.getElementById('add-channel-input');
        const message = document.getElementById('add-channel-msg');
        const username = input.value.replace(/^@/, '').trim();
        message.textContent = '';
        try {
          await API.req('/api/channels', { method: 'POST', body: JSON.stringify({ username }) });
          input.value = '';
          await reloadChannels();
          await render();
          message.style.color = 'var(--color-accent-green)';
          message.textContent = 'Канал добавлен';
        } catch (error) {
          message.style.color = 'var(--color-vibrant-orange)';
          message.textContent = error.message;
        }
      });
    }

    return { render, bindAddForm };
  };
})();
