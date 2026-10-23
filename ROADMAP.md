# Дорожная карта производства — DeepSeek Harness Desktop Installer

Цель: установочная desktop-программа (Electron-оболочка вокруг deepseek-harness) для **Windows, Linux, macOS**.

## Исходное положение
- Репозиторий источника: https://github.com/deepseek-ai/deepseek-harness (уже содержит `apps/desktop` — Electron-оболочку, NSIS-инсталлятор под Windows, DMG под macOS, первичный рантайм Python/Node/pnpm, автообновление через `electron-updater`, код-подпись Windows EV и macOS Developer ID, нотаризацию macOS).
- Целевой репозиторий (локально): `E:\Git\Harness` — пуст, будем переносить и адаптировать десктоп-сборку под три платформы.
- Текущая ОС разработки: Windows.

---

## Этап 0 — Подготовка и перенос (1–2 недели)

| # | Задача | Ожидаемый результат |
|---|--------|---------------------|
| 0.1 | Склонировать / скопировать `apps/desktop` из deepseek-harness в локальный репозиторий | Рабочая копия десктоп-приложения |
| 0.2 | Установить Node.js 24.9+, Corepack, pnpm 11.28.5, Git 2.26+ | Окружение готово к сборке |
| 0.3 | `pnpm install` в корне (или в `apps/desktop`) | Зависимости установлены |
| 0.4 | Настроить `.env.windows` / `.env.macos` шаблоны (копия из `.env.*.example`) | Локальная конфигурация без секретов в git |
| 0.5 | Проверить `pnpm run typecheck` и `pnpm run build` | Сборка проходит без ошибок |

---

## Этап 1 — Windows: установочный programas (приоритет, 2–4 недели)

Цель: готовый `.exe` инсталлятор для Windows x64.

| # | Задача | Ожидаемый результат |
|---|--------|---------------------|
| 1.1 | Адаптировать `apps/desktop/installer/*.nsh`, `*.cpp`, `*.h` (NSIS UI, страницы, трей, лайфсайкл) | Локализованный мастер установки |
| 1.2 | Настроить `electron-builder.config.mjs` для `win:x64` (NSIS, MachineGuided installer, иконки .ico) | Конфиг сборки под Windows |
| 1.3 | Подготовить иконки: `resources/icon-windows.ico`, `resources/tray-windows.ico` (из `icon-windows.svg`) | Ресурсы приложения |
| 1.4 | Код-подпись Windows (EV-сертификат, SignTool, кэш подписей, промежуточная проверка PE) | Подписанный инсталлятор |
| 1.5 | Команда сборки: `pnpm run package:desktop:win:x64` (подписано) и `:unsigned` (тест) | `.exe` в `.desktop-build/targets/win-x64/` |
| 1.6 | Тест установки/удаления, регистрация `dsh` в PATH, проверка работы приложения | Инсталлятор работает end-to-end |

---

## Этап 2 — macOS: установочный programas (2–4 недели)

Цель: готовый `.dmg` (и `.zip`) для Apple Silicon (arm64) и Intel (x64).

| # | Задача | Ожидаемый результат |
|---|--------|---------------------|
| 2.1 | Адаптировать `electron-builder.config.mjs` для `mac-arm64`, `mac-x64` (DMG ULMO сжатие, ICNS) | Конфиг сборки под macOS |
| 2.2 | Подготовить иконки: `resources/icon-macos.icns`, `resources/icon-macos.png` (из `icon-macos.svg`) | Ресурсы приложения |
| 2.3 | Настроить код-подпись macOS (Developer ID Application, hardened runtime,secure timestamp) | Подписанное приложение |
| 2.4 | Настроить нотаризацию и stapling через `@electron/notarize` + Apple notarytool | Нотаризированное приложение |
| 2.5 | Команда сборки: `pnpm run package:desktop:mac:arm64` / `package:desktop:mac:x64` | `.dmg` и `.zip` |
| 2.6 | Тест установки через копирование `.app` в `/Applications`, проверка Gatekeeper | Инсталлятор работает end-to-end |

---

## Этап 3 — Linux: установочный programas (3–6 недель)

Цель: готовые пакеты для Linux (AppImage + .deb + .rpm), т.к. в дорелизном deepseek-harness Linux не является основной мишенью.

| # | Задача | Ожидаемый результат |
|---|--------|---------------------|
| 3.1 | Добавить Linux-цель в `electron-builder.config.mjs` (`appImage`, `deb`, `rpm`, `target: generic`) | Конфиг сборки под Linux |
| 3.2 | Подготовить иконки: `resources/icon-linux.png`, `.desktop` файл | Ресурсы приложения |
| 3.3 | Установить инструменты сборки Linux (fakeroot, dpkg, rpmbuild, electron-builder linux deps) | Инструменты готовы |
| 3.4 | Команда сборки: `pnpm run package:desktop:linux:x64` / `linux:arm64` | `.AppImage`, `.deb`, `.rpm` |
| 3.5 | Тест установки на Ubuntu/Debian и Fedora/CentOS | Инсталлятор работает end-to-end |

---

## Этап 4 — Автообновление и публикация (parallel, 2–3 недели)

| # | Задача | Ожидаемый результат |
|---|--------|---------------------|
| 4.1 | Настроить канал обновлений (`nightly` / `latest`) через `electron-updater` | Проверка обновлений работает |
| 4.2 | Настроить публикацию artefacts (GitHub Releases или приватный бакет) | Загрузка версий |
| 4.3 | Настроить CI workflow: `package.yml` для Windows и macOS (ручной запуск) | Сборка по коммиту / вручную |
| 4.4 | Теггирование релиза: `desktop-v<version>` после публикации | Версии помечены |

---

## Этап 5 — Качество, тестирование и релиз (1–2 недели)

| # | Задача | Ожидаемый результат |
|---|--------|---------------------|
| 5.1 | Smoke-тесты запуска приложения на каждой платформе | Приложение стартует |
| 5.2 | Тесты установки/удаления (Windows NSIS, macOS DMG, Linux пакеты) | Инсталляторы работают |
| 5.3 | Проверка цифровых подписей (Windows SignTool, macOS codesign --verify) | Подписи валидны |
| 5.4 | Документация по установке для пользователей | `docs/install.md` |
| 5.5 | Релиз v1.0.0 для Windows, macOS, Linux | Готовые установочные файлы |

---

## Matrice поддержки платформ

| Платформа | Формат | Архитектура | Статус |
|-----------|--------|-------------|--------|
| Windows | NSIS `.exe` | x64 | Этап 1 |
| macOS | `.dmg` + `.zip` | arm64, x64 | Этап 2 |
| Linux | `.AppImage`, `.deb`, `.rpm` | x64, arm64 | Этап 3 |

---

## Команды сборки (локально)

```bash
# Windows (требуется Windows x64)
pnpm run package:desktop:win:x64        # подписанный
pnpm run package:desktop:win:x64:unsigned  # тестовый, без подписи

# macOS (требуется macOS)
pnpm run package:desktop:mac:arm64      # Apple Silicon
pnpm run package:desktop:mac:x64        # Intel / Rosetta

# Linux
pnpm run package:desktop:linux:x64      # планируется (Этап 3)
```

## Зависимости окружения

- **Windows:** Node 24.9+, pnpm 11.28.5, PowerShell 7, Visual C++ Build Tools, Windows SDK, SignTool (для подписи).
- **macOS:** Xcode, macOS SDK, Apple Developer ID сертификат, нотаризационные учётные данные.
- **Linux:** Node 24.9+, pnpm, fakeroot, dpkg-dev, rpmbuild.

---

*Документ актуализируется после завершения каждого этапа.*
