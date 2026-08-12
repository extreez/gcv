# gcv-__SERVICE__

Самостоятельный CLI и MCP-сервер для __SERVICE_NAME__. Node 20+, ESM,
**ноль зависимостей**. Соответствует CLI-CONTRACT v1.

Документация сервиса: __DOCS_URL__

---

## Что важно знать про __SERVICE_NAME__

<!-- Заполнить после разведки API. Обязательно ответить на вопрос про момент
     списания денег — от него зависит всё поведение при сбоях. -->

| | |
|---|---|
| Модель работы | TODO: синхронная / асинхронная |
| Момент списания | TODO |
| Факт стоимости | TODO: поле в ответе или «не возвращается» |
| Валюта | TODO: кредиты / USD |
| Отмена | TODO |
| Референсы | TODO: URL / загрузка файлов |

---

## Установка

```bash
npm link
```

```bash
gcv-__SERVICE__ doctor
```

Ключ:

```bash
gcv-__SERVICE__ config set providers.__SERVICE__.apiKey <ключ>
```

Или `__SERVICE_UPPER___API_KEY` в `.env` проекта либо в окружении.
Ключ берётся на __API_KEY_URL__

---

## Команды

```bash
gcv-__SERVICE__ doctor
```

```bash
gcv-__SERVICE__ balance
```

```bash
gcv-__SERVICE__ catalog refresh
```

```bash
gcv-__SERVICE__ catalog set --model <id> --type image --credits <N> --price-unit per_image
```

```bash
gcv-__SERVICE__ estimate --model <id> --count 3
```

```bash
gcv-__SERVICE__ generate --model <id> --prompt "..." --count 3 --out ./out --wait --max-cost 200
```

```bash
gcv-__SERVICE__ ledger
```

---

## Предохранители

| Флаг | Что делает |
|---|---|
| `--max-cost N` | Отказ (exit 10), если смета выше N |
| `--dry-run` | Полная проверка без траты денег и без сети |
| `--idempotency-key K` | Повтор с тем же ключом не создаёт новую задачу |
| `--force` | Игнорировать идемпотентность |

Идемпотентность включена по умолчанию. Проверка баланса выполняется до создания
задачи.

---

## Машинный режим

```bash
gcv-__SERVICE__ generate --model <id> --prompt "..." --out ./out --wait --json
```

- **stdout** — один JSON-конверт `{ok, contract, provider, command, data, meta}`
- **stderr** — NDJSON-события прогресса
- решения принимаются по **exit-коду**: 0 ок, 2 аргументы, 3 ключ,
  4 нет средств, 7 генерация упала, 10 лимит, 11 валидация

---

## MCP

```bash
node mcp/server.mjs --api-key <ключ>
```

Тонкая обёртка над теми же модулями `src/`. Ключ в аргументах виден в списке
процессов ОС — где это важно, используй переменную окружения.

---

## Устройство

Правится один файл — `src/provider.mjs`. Остальное в `src/` общее для всех
провайдеров и правке не подлежит.

Проверка соответствия контракту:

```bash
node ../verify-contract.mjs .
```
