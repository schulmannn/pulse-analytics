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

    // ПОЛЬЗОВАТЕЛЬСКАЯ ТЕМА («Оформление»). Здесь ничего не считается: студия кладёт в
    // localStorage готовый CSS со штампом генератора в первой строке, бутстрап только вставляет
    // его. Ключ, штамп и id зеркалят src/lib/appearanceStorage.ts — меняешь там, меняй здесь;
    // расхождение штампов лишь откладывает применение до монтирования оболочки. Файл едет в
    // браузер БЕЗ минификации (public/), поэтому комментарий здесь короткий.
    var cached = null;
    try {
      cached = localStorage.getItem('pulse_appearance_css');
    } catch (e2) {
      /* localStorage may be unavailable */
    }
    var split = cached ? cached.indexOf('\n') : -1;
    if (split > 0 && cached.slice(0, split) === '1') {
      var css = cached.slice(split + 1);
      // Кэш свой, но проверка дешевле доверия: длина, отсутствие внешних загрузок и разметки.
      // textContent не парсит HTML, так что вставка не может вырваться из <style>.
      if (css.length < 20000 && !/[<>]|@import|url\(|expression\(/i.test(css)) {
        var style = document.createElement('style');
        style.id = 'pulse-appearance';
        style.textContent = css;
        document.head.appendChild(style);
      }
    }
  } catch (e) {
    /* тема — не повод ронять загрузку приложения */
  }
})();
