/* PREPAINT THEME BOOTSTRAP — ставит `.dark` на <html> ДО первого кадра (ThemeProvider делает это из
   useEffect, т.е. уже после первого paint → тёмная тема мигала светлым).
   Логика — ЗЕРКАЛО src/lib/theme.tsx: тот же ключ `pulse_theme`, те же значения light|dark|system,
   тот же дефолт system → prefers-color-scheme. Меняешь там — меняй здесь (проверяется e2e
   theme-fouc.spec.ts). Отдельный файл, а не inline: CSP `script-src 'self'` без nonce и без
   'unsafe-inline' (server/lib/securityHeaders.js). Подключение и его место — см. index.html. */
(function () {
  try {
    var stored = null;
    try {
      stored = localStorage.getItem('pulse_theme');
    } catch (e) {
      /* localStorage may be unavailable */
    }
    var mode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    var dark =
      mode === 'dark' ||
      (mode === 'system' &&
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    var html = document.documentElement;
    html.classList.toggle('dark', dark);
    // `color-scheme` до загрузки CSS: нативный фон документа, скроллбары и контролы сразу тёмные.
    // Дальше значение ведёт ThemeProvider (инлайновый стиль перебивает :root/.dark из index.css).
    html.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {
    /* тема — не повод ронять загрузку приложения */
  }
})();
