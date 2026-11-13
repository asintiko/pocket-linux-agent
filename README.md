# Pocket Linux Agent

Linux-агент Pocket: команды, скриншоты, клики, клавиатура и буфер обмена. Каждый чат может работать в отдельном X11-рабочем столе с собственным браузерным профилем; рабочий стол пользователя остаётся отдельным.

Это публичный снимок Linux-разработки из `karettelinaliinbel-cpu/pocket-linux-workspaces`, commit `2dc2e3162e759c79b57fd455342f83bcd09d88d1`. Содержимое прежней папки `lx/` находится **в корне этого репозитория**: добавлять `lx/` к путям ниже не нужно. Windows-установщики здесь не публикуются.

## Что требуется

- Kali / Debian / Ubuntu с systemd и обычным пользовательским аккаунтом.
- Node.js **22 или новее**, npm, Git; pnpm устанавливается через npx при необходимости.
- Интернет на Linux и доступный Brain + Node relay. Brain выполняет запросы к модели, Linux-агент исполняет её команды. Один Linux-агент без Brain не отвечает на сообщения.
- Для отдельных рабочих столов достаточно Xvfb: собственный графический сеанс не нужен.
- Для управления **вашим основным экраном**, просмотра рабочего стола и визуального оверлея используйте терминал внутри **X11**, например Xfce. На Wayland эти возможности основного экрана не поддерживаются.
- Установка пакетов запрашивает sudo. Сам агент запускается от обычного пользователя, **не через sudo**.

## 1. Скачать и установить на Linux

Откройте терминал под своим обычным пользователем. Если требуется основной экран, делайте это непосредственно в графическом X11-сеансе Linux, а не по SSH.

```bash
sudo apt-get update
sudo apt-get install -y git firefox-esr xauth
node --version
npm --version
```

Для Ubuntu вместо `firefox-esr` установите доступный для вашей системы Firefox или Chromium. Браузер нужен внутри рабочих столов агента. Если Node младше 22, сначала установите поддерживаемую версию Node; продолжать установку со старой версией нельзя.

```bash
cd "$HOME"
git clone https://github.com/asintiko/pocket-linux-agent.git
cd "$HOME/pocket-linux-agent"
bash apps/clipboard-agent/scripts/install-linux.sh
```

Не запускайте команду `bash lx/apps/...`: в этом репозитории папки `lx` нет. Если каталог клона уже существует, используйте раздел «Обновить» ниже.

Установщик сам устанавливает системные зависимости через apt, скачивает зависимости проекта, собирает `agent.cjs`, копирует Python-помощники и создаёт пользовательскую службу `pocket-clipboard.service`. При первом запуске он запросит ссылку подключения с телефона.

Доступ к сервису после установки:

```bash
export PATH="$HOME/.local/bin:$PATH"
PocketClipboard status
systemctl --user status pocket-clipboard.service --no-pager
```

Для вызова без изменения PATH используйте `"$HOME/.local/bin/PocketClipboard"` вместо `PocketClipboard`.

## 2. Подключить Linux к телефону

1. Убедитесь, что Pocket на iPhone/Android уже подключён к вашему Brain и Brain доступен.
2. На телефоне откройте список компьютеров → **Add computer / Добавить компьютер** → способ **по ссылке**. Скопируйте ссылку `pocketclaude://...`.
3. Вставьте её в Linux-терминал в приглашение `Link or code from the phone:` и нажмите Enter.
4. Сравните safety number на телефоне и в терминале. Подтвердите только совпадающий номер.
5. В приложении выберите добавленный Linux-компьютер исполнителем нужного чата.

**Этот Linux-снимок использует ссылку с телефона. Четырёхсимвольный код, который показывают Windows-установщики, не является способом установки этого Linux-агента.** Полная ссылка предпочтительнее голого кода: она содержит правильный адрес relay.

Если установщик завершился до привязки или надо привязать устройство заново:

```bash
"$HOME/.local/bin/PocketClipboard" pair
"$HOME/.local/bin/PocketClipboard" status
```

Личные ключи, состояния привязки, API-ключи и чужие аккаунты в репозиторий не входят. Существующая привязка хранится локально на устройстве.

## 3. Запуск, остановка и журнал

После успешной установки агент запускается пользовательской службой. Обычно открывать отдельный терминал постоянно не требуется.

```bash
# Запустить / перезапустить / остановить
systemctl --user start pocket-clipboard.service
systemctl --user restart pocket-clipboard.service
systemctl --user stop pocket-clipboard.service

# Проверить
"$HOME/.local/bin/PocketClipboard" status
journalctl --user -u pocket-clipboard.service -n 80 --no-pager
tail -n 80 "$HOME/.pocket-clipboard/agent.log"
```

Ручной запуск для диагностики, когда служба остановлена:

```bash
systemctl --user stop pocket-clipboard.service
"$HOME/.local/bin/PocketClipboard" run
```

Ctrl+C завершает ручной запуск. Затем верните службу:

```bash
systemctl --user start pocket-clipboard.service
```

Автозапуск службы привязан к пользовательской сессии. Для работы после выхода из всех сеансов администратор при необходимости включает linger:

```bash
sudo loginctl enable-linger "$USER"
```

## 4. Отдельные рабочие столы для чатов

```bash
export PATH="$HOME/.local/bin:$PATH"
PocketClipboard workspaces on
PocketClipboard workspaces
```

Когда чат впервые использует компьютер, агент создаёт его Xvfb-дисплей, Openbox, D-Bus и профиль браузера. Чтобы увидеть его из своего X11-сеанса:

```bash
PocketClipboard workspaces
# Замените DESKTOP_ID на идентификатор из вывода предыдущей команды.
PocketClipboard workspaces view DESKTOP_ID
PocketClipboard workspaces shot DESKTOP_ID "$HOME/pocket-desktop.png"
```

`view` — просмотр без ввода. Для SSH используйте `shot` и сохранённую картинку.

Следующие действия закрывают процессы рабочего стола. `reset` сохраняет файлы; `delete` удаляет также данные выбранного рабочего стола:

```bash
PocketClipboard workspaces reset DESKTOP_ID
PocketClipboard workspaces delete DESKTOP_ID
```

Рабочие столы разделяют Linux-аккаунт и сеть; это отдельные X11-сеансы, **не отдельные виртуальные машины и не граница безопасности для файлов**. Браузерные сессии и логины из вашего обычного браузера автоматически не переносятся.

## 5. Разрешить основной экран Linux

Необязательно. Требуется установка из собственного X11-сеанса и согласие пользователя на computer use в Pocket.

```bash
export PATH="$HOME/.local/bin:$PATH"
PocketClipboard computer on
```

Для режима работы именно на основном экране, вместо отдельных столов:

```bash
PocketClipboard workspaces off
PocketClipboard computer on
```

Вернуться к отдельным рабочим столам:

```bash
PocketClipboard workspaces on
```

Отключить доступ к основному экрану:

```bash
PocketClipboard computer off
```

`workspaces on/off` — настройка всего Linux-агента, а не Windows slash-команды `/TERM` и `/SEND`. На Linux этот снимок не реализует Windows-режимы.

Визуальный оверлей включается отдельно, если он нужен:

```bash
PocketClipboard blocker on
PocketClipboard blocker off
```

Это оверлей приложения, а не системная блокировка Linux. Его проверка на вашей графической сессии не выполнена в рамках этой публикации.

## 6. Если Brain ещё не установлен

Если телефон уже работает с вашим Mac Brain, этот раздел пропустите: второй Brain не нужен. На новом Mac требуются Node.js 22+, Git, pnpm и установленный/авторизованный Claude Code CLI. Для других провайдеров отдельно настраиваются собственные ключи; ключи владельца сюда не включены.

```bash
git clone https://github.com/asintiko/pocket-linux-agent.git
cd pocket-linux-agent
npx --yes pnpm@11.25.0 install --frozen-lockfile
bash apps/brain/install/install.sh --public-url https://YOUR-RELAY-HOST
node apps/brain/bin/pocket-claude.mjs status
node apps/brain/bin/pocket-claude.mjs pair
```

`YOUR-RELAY-HOST` нужно заменить реальным HTTPS-адресом, который ведёт к Node relay на Mac (локальный порт установщика — 8797). `--public-url` **не создаёт туннель и не выпускает сертификат**. Настройте свой reverse proxy/туннель; короткие Windows-коды Cloudflare Worker relay в этом снимке не поддерживает.

Для уже настроенного ngrok можно использовать опцию установщика `--ngrok https://YOUR-NGROK-DOMAIN` вместо `--public-url`. Сам ngrok и его авторизация должны быть настроены заранее.

Отсканируйте QR или откройте ссылку из `pair` в Pocket на телефоне. После привязки телефона добавляйте Linux-компьютер по разделу 2.

Готовый Android APK: [скачать последнюю опубликованную сборку](https://github.com/asintiko/pocket-linux-agent/releases/download/android-2026-11-13/pocket-integration-release.apk). Версия 0.1.0, около 120 MiB, тестовая подпись Android Debug. SHA-256 и происхождение сборки указаны в [Release](https://github.com/asintiko/pocket-linux-agent/releases/tag/android-2026-11-13). Скачайте APK на Android и откройте его; при совместимой подписи можно установить поверх приложения. IPA не опубликован.

Для установки APK с компьютера по USB при включённой отладке Android:

```bash
adb install -r pocket-integration-release.apk
```

Этот репозиторий также содержит исходники мобильного приложения из Linux snapshot. Опубликованный APK взят из более поздней интеграционной мобильной сборки; его исходный HEAD указан в Release. Инструкции самостоятельной сборки: [apps/mobile/README.md](apps/mobile/README.md). Для iOS нужны Mac, Xcode и ваша подпись Apple; Expo Go не заменяет сборку приложения.

## 7. Обновить Linux-агент

Остановка/повторная установка могут завершить активные команды и рабочие столы; сначала закончите важную работу.

```bash
cd "$HOME/pocket-linux-agent"
git pull --ff-only
bash apps/clipboard-agent/scripts/install-linux.sh
"$HOME/.local/bin/PocketClipboard" status
```

Повторную установку для работы с основным экраном выполняйте в X11-сеансе. Не копируйте чужие `state.json`, ключи и browser profiles.

## 8. Удалить

```bash
"$HOME/.local/bin/PocketClipboard" uninstall
```

Команда останавливает и отключает пользовательскую службу, убирает её unit и удаляет привязку устройства. Перед ручным удалением `~/.pocket-clipboard` сохраните нужные данные рабочих столов; там находятся ключи устройства, состояние, журналы и профили. Системные пакеты apt автоматически не удаляются.

## 9. Проверить из приложения

Выберите Linux-компьютер в чате, затем отправьте:

```text
Проверь реальную работу выбранного Linux-компьютера. Сначала перечисли доступные инструменты и выполни команду printf 'POCKET_LINUX_OK\n'; uname -s; pwd. Покажи фактический вывод. Затем сделай скриншот рабочего стола этого чата, открой в его браузере https://example.com и сделай второй скриншот. Проверь ввод текста и буфер обмена на тестовом тексте POCKET_TEST, предварительно сохрани и затем восстанови прежний буфер. Для каждого шага укажи PASS, FAIL или NOT TESTED и результат инструмента. Если инструмент отсутствует, сообщи его имя; не выдавай объяснение за выполненную проверку. Не меняй пользовательские документы и настройки системы.
```

Чтобы проверить разделение, создайте два чата с этим же Linux-компьютером и попросите каждый открыть разные страницы в собственном браузере. Сравните их через `PocketClipboard workspaces` и `workspaces view`. На основном экране пользователь не должен терять фокус из-за работы в отдельных столах.

## 10. Проверки исходников и ограничения

```bash
npx --yes pnpm@11.25.0 install --frozen-lockfile
npx --yes pnpm@11.25.0 --filter @pocket/clipboard-agent typecheck
npx --yes pnpm@11.25.0 exec vitest run apps/clipboard-agent/test/workspaces.test.ts apps/clipboard-agent/test/workspace-agent.test.ts
bash -n apps/clipboard-agent/scripts/install-linux.sh
```

Предыдущий Linux-агент сообщал о проверках настоящих X-серверов/браузеров и systemd в CI. Последний lifecycle-fix не был полностью перепроверен в CI на момент сохранения. Live-model, реальный iPhone и графическая установка владельца не были подтверждены тем handoff. Есть известные старые ошибки lock-screen layout/render. Не считайте этот снимок завершённым релизом.

Подробная сохранённая история: [HANDOFF.md](HANDOFF.md), прежде всего раздел 0.0. В старом handoff пути с `lx/` относятся к исходному репозиторию; в этой публикации убирайте префикс `lx/`.
