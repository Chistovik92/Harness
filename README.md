# DeepSeek Harness Desktop

Полноценное десктоп-приложение (стиля Claude Code / ChatGPT / Google Gemini) на базе [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Работает на **Windows, Linux, macOS**. Это Electron-оболочка с React-интерфейсом, которая объединяет несколько LLM-провайдеров в одном приложении с локальной историей чатов, зашифрованным хранением ключей API и возможностью запуска локальных моделей Hugging Face.

---

## Возможности

| Возможность | Описание |
|-------------|----------|
| **Много провайдеров** | DeepSeek, OpenAI, Anthropic (Claude), Google (Gemini), Groq, Together, OpenRouter, Hugging Face (API + локально) |
| **Локальные ключи API** | Ключи вводятся один раз и хранятся зашифрованно (AES-256-GCM) на вашем компьютере в `userData` |
| **Локальные модели HF** | Запуск моделей Hugging Face локально через встроенный рантайм (Transformers.js / llama.cpp) |
| **Стриминг ответов** | Ответы модели приходят по токену в реальном времени |
| **История чатов** | Сессии и сообщения сохраняются локально (IndexedDB), доступны после перезапуска |
| **Маркдаун + код** | Отрисовка сообщений с подсветкой кода, формулами и вложениями |
| **Автообновление** | Проверка и установка новых версий через `electron-updater` |
| **Установщики** | Windows (NSIS `.exe`), macOS (`.dmg` / `.zip`), Linux (`.AppImage` / `.deb`) |

---

## Скриншоты

*(добавьте скриншоты в `docs/screenshots/`)*

---

## Быстрый старт

### Предварительные требования

- Node.js 24.9+
- pnpm 11.28.5 (через Corepack)
- Git 2.26+

### Установка зависимостей

```bash
git clone https://github.com/Chistovik92/Harness.git
cd Harness
cd apps/desktop-app
npm install   # или pnpm install
```

### Запуск в режиме разработки

```bash
npm run dev
```

Запускает Vite dev server + Electron. Откроется окно приложения с hot-reload интерфейса.

### Сборка

```bash
npm run build
```

Собирает React-интерфейс (Vite) и Electron main-процесс в `dist/`.

### Установщики (релизные артефакты)

```bash
# Windows x64 (требуется Windows)
npm run package:win

# macOS (требуется macOS; Apple Silicon или Intel)
npm run package:mac

# Linux (требуется Linux)
npm run package:linux

# Все платформы сразу (требуется мультиплатформенный раннер)
npm run package:all
```

Готовые файлы appear в `release/`.

---

## Конфигурация

### API-ключи

При первом запуске откройте раздел **«Провайдеры API»** и добавьте ключ для нужного провайдера:

- **DeepSeek** — `https://platform.deepseek.com/apiKeys`
- **OpenAI** — `https://platform.openai.com/api-keys`
- **Anthropic** — `https://console.anthropic.com/`
- **Google** — `https://makersuite.google.com/app/apikey`
- **Hugging Face** — `https://huggingface.co/settings/tokens`

Ключи хранятся **только локально** в зашифрованном виде и никогда не передаются третьим лицам, кроме выбранного вами провайдера при отправке запроса.

### Локальные модели Hugging Face

В разделе провайдеров выберите **«Hugging Face (Локально)»**.

Поддерживаются модели из `@xenova/transformers`, например:
- `Xenova/llama2.c-stories15M` — 15 M параметров, очень быстро работает на CPU
- `Xenova/gpt-2` — 117 M параметров

Модели скачиваются в `userData/hf-cache` при первом использовании и запускаются **полностью локально** в отдельном Worker-потоке Electron (без отправки данных наружу). Генерация стримится по токену в реальном времени.

> Примечание: большие модели (7B+) требуют много оперативной памяти и могут не запуститься на слабых машинах. Для них используйте провайдера «Hugging Face (API)» с токеном HF.

---

## Архитектура

```
apps/desktop-app/
├── src/
│   ├── electron/
│   │   ├── main.ts          # Основной процесс: окна, трей, IPC, автообновление, шифрование ключей
│   │   └── preload.ts       # Мост между main и рендерером (contextBridge)
│   └── renderer/
│       ├── App.tsx          # Главный чат-интерфейс
│       ├── ProvidersPage.tsx# Управление провайдерами и ключами API
│       ├── SettingsPage.tsx # Общие настройки
│       ├── context/         # React Context: DshContext, ChatContext
│       ├── lib/             # Провайдеры LLM, шифрование, IndexedDB-хранилище
│       └── index.html
├── resources/               # Иконки,’entitlements, LICENSE
├── electron-builder.json    # Конфигурация сборки installers (NSIS/DMG/AppImage)
├── vite.config.ts           # Vite конфиг
├── tailwind.config.js       # Стили
└── package.json
```

---

## CI/CD и релизы

Сборка и публикация автоматизированы через GitHub Actions:

- **Windows** — NSIS инсталятор `.exe` (подпись EV-сертификатом, опционально)
- **macOS** — `.dmg` + `.zip` (Apple Silicon arm64 + Intel x64, нотаризация Apple)
- **Linux** — `.AppImage`, `.deb`

Артефакты публикуются на [GitHub Releases](https://github.com/Chistovik92/Harness/releases) при создании тега `v*`.

---

## Лицензия

Распространяется под лицензией **MIT**. См. [LICENSE](LICENSE).

---

## Связанные проекты

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — исходный проект с обменом плагинами
- [Electron](https://www.electronjs.org/) — фреймворк десктоп-оболочки
- [React](https://react.dev/) + [Vite](https://vitejs.dev/) — интерфейс
