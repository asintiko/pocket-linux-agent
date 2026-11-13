/**
 * The camera viewer: one page, served by the relay, that shows frames of a computer's webcam for as long as the link
 * lives. The page holds no secret beyond its own token, which the relay validates on every frame.
 */
export const CAMERA_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111114">
<title>Камера</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #111114; color: #e8e8ee; font: 15px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif; }
  #frame { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
  #bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 14px calc(12px + env(safe-area-inset-bottom)); display: flex; gap: 10px; align-items: center;
         background: linear-gradient(transparent, rgba(0,0,0,.75)); font-size: 13px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: #6bd58a; }
  #dot.off { background: #ff7a85; }
  #text { flex: 1; }
  #stop { border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.08); color: inherit; border-radius: 8px; padding: 7px 12px; font: inherit; }
  #splash { position: fixed; inset: 0; display: grid; place-items: center; text-align: center; padding: 24px; font-size: 16px; }
  #splash small { display: block; margin-top: 8px; opacity: .6; font-size: 13px; }
</style>
</head>
<body>
<img id="frame" alt="" hidden>
<div id="splash">Смотрю…<small>Кадры идут раз в пару секунд</small></div>
<div id="bar">
  <span id="dot"></span><span id="text">Подключаюсь</span>
  <button id="stop" type="button">Стоп</button>
</div>
<script>
  var token = location.pathname.split('/').filter(Boolean).pop() || '';
  var frame = document.getElementById('frame');
  var splash = document.getElementById('splash');
  var dot = document.getElementById('dot');
  var text = document.getElementById('text');
  var stopped = false;

  function state(ok, label) { dot.className = ok ? '' : 'off'; text.textContent = label; }

  function stop(done) {
    if (stopped) return;
    stopped = true;
    fetch('/camera/' + encodeURIComponent(token) + '/stop', { method: 'POST' }).catch(function () {});
    state(false, done || 'Остановлено');
    frame.hidden = true;
    splash.hidden = false;
    splash.textContent = 'Остановлено';
  }
  document.getElementById('stop').addEventListener('click', function () { stop(); });

  function next() {
    if (stopped) return;
    fetch('/camera/' + encodeURIComponent(token) + '/frame', { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (r) {
        if (stopped) return;
        if (!r.ok || !r.body.image) {
          state(true, r.body.error || 'Жду кадр');
          if (r.body.expired) return stop('Ссылка истекла');
        } else {
          frame.src = 'data:' + r.body.image.mime + ';base64,' + r.body.image.dataBase64;
          frame.hidden = false;
          splash.hidden = true;
          state(true, new Date().toLocaleTimeString());
        }
        setTimeout(next, 1500);
      })
      .catch(function () {
        state(false, 'Нет связи');
        setTimeout(next, 4000);
      });
  }
  next();
</script>
</body>
</html>
`;
