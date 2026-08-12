# Шаблон gcv-{service}

Из этой папки рождается новый самостоятельный CLI под любой сервис генерации.
Пользуется им скилл `gcv`; вручную тоже можно.

## Что здесь есть

| Файл | Правится под сервис? |
|---|---|
| `src/provider.mjs` | **Да. Это единственный файл, который нужно написать** |
| `src/models.seed.json` | Да, список известных моделей |
| `src/errors.mjs` | Нет |
| `src/config.mjs` | Нет |
| `src/io.mjs` | Нет |
| `src/store.mjs` | Нет |
| `src/generate.mjs` | Нет |
| `src/index.mjs` | Нет |
| `bin/cli.mjs` | Нет |
| `mcp/server.mjs` | Нет |
| `package.json` | Только подстановка имени |

Идея: механика (ретраи, поллинг, идемпотентность, журнал трат, exit-коды,
конверт `--json`) одинакова у всех сервисов и уже написана. Различается только
то, как сервис устроен снаружи — это `provider.mjs`.

## Как породить новый CLI

```bash
node ../scaffold.mjs --service fal --name "fal.ai" --base-url https://fal.run --out ~/projects/gcv-fal
```

Скрипт копирует шаблон, подставляет имена и оставляет `provider.mjs` с
пометками `TODO`. Дальше их надо закрыть по документации сервиса.

## Что должен реализовать provider.mjs

```js
export const PROVIDER = {
  id, name, baseUrl, currency,        // 'credits' | 'usd'
  docs, apiKeyEnv, apiKeyUrl,
  supports: { cancel, upload, webhook, sync },
};

export async function getBalance(apiKey, timeoutMs)
//   → { amount, currency, usd }   usd = null, если курс неизвестен

export async function createTask(apiKey, { model, input, callBackUrl }, timeoutMs)
//   → taskId (строка).  ЗДЕСЬ СПИСЫВАЮТСЯ ДЕНЬГИ — без автоповторов

export async function getTask(apiKey, taskId, timeoutMs)
//   → { taskId, model, state, progress, costActual, failCode, failMsg,
//       costTimeMs, resultUrls[], result }
//   state приводится к: waiting | queuing | generating | success | fail

export async function uploadFile(apiKey, filePath, opts)
//   → { url, fileName, bytes, mimeType, expiresInDays }
//   если сервис не требует загрузки — бросить notSupported()

export async function refreshCatalog({ timeoutMs })
//   → { updated, count, source, needsManual, hint }

export function mapError(status, body, context)
//   → GcvError | null   (null = отдать разбор дефолтной логике)
```

Ничего больше. Всё остальное шаблон делает сам.

## Синхронные сервисы

Если сервис отвечает результатом сразу, без `taskId`:
`createTask` возвращает синтетический id, `getTask` отдаёт по нему сохранённый
результат со `state: 'success'`. Заготовка для этого — в комментариях
`provider.mjs`.

## Проверка соответствия контракту

```bash
node ../verify-contract.mjs ~/projects/gcv-fal
```

Прогоняет команды и сверяет форму ответа и exit-коды с
[CLI-CONTRACT](../../reference/CLI-CONTRACT.md). Пока проверка не проходит, CLI
считать неготовым: `/creative` рассчитывает на контракт, а не на добрую волю.

## Чего не делать

- Не переписывать механику под «особенности сервиса». Если что-то не ложится в
  шаблон — сначала убедись, что это действительно про сервис, а не про лень
- Не выдумывать цены и слаги моделей. Неизвестное значение — `null`
- Не отключать идемпотентность и предохранители
- Не добавлять зависимости: шаблон zero-dep, и порождённый CLI тоже
