import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOKEN = process.env.CLICKUP_API;
const TEAM_ID = process.env.TEAM_ID;

if (!TOKEN || !TEAM_ID) {
  process.stderr.write("CLICKUP_API или TEAM_ID не заданы\n");
  process.exit(1);
}

function parseDateRange(date, startDate, endDate) {
  if (startDate && endDate) {
    const start = (([y, m, d]) => new Date(+y, +m - 1, +d))(startDate.split("-"));
    start.setHours(0, 0, 0, 0);
    const end = (([y, m, d]) => new Date(+y, +m - 1, +d))(endDate.split("-"));
    end.setHours(23, 59, 59, 999);
    return [start, end];
  }
  const d = date
    ? (([y, m, d]) => new Date(+y, +m - 1, +d))(date.split("-"))
    : new Date();
  d.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return [d, end];
}

async function fetchEntries(date, startDate, endDate) {
  const [start, end] = parseDateRange(date, startDate, endDate);
  const params = new URLSearchParams({
    start_date: start.getTime(),
    end_date: end.getTime(),
    include_location_names: true,
  });
  const res = await fetch(
    `https://api.clickup.com/api/v2/team/${TEAM_ID}/time_entries?${params}`,
    { headers: { Authorization: TOKEN } },
  );
  if (!res.ok) {
    throw new Error(`ClickUp API ${res.status}: ${await res.text()}`);
  }
  const { data } = await res.json();
  return data ?? [];
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(Number(ms) / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function groupEntries(entries, groupBy = "folder") {
  const getKey = (entry) => {
    switch (groupBy) {
      case "folder": return entry.task_location?.folder_name ?? "Без папки";
      case "list":   return entry.task_location?.list_name ?? "Без борды";
      case "user":   return entry.user?.username ?? "Неизвестный";
      case "billable": return entry.billable ? "Billable" : "Unbillable";
      case "task":   return entry.task?.name ?? "Без задачи";
      case "space":  return entry.task_location?.space_name ?? "Без спейса";
      default:       return entry.task_location?.folder_name ?? "Без папки";
    }
  };
  const grouped = {};
  for (const entry of entries) {
    const key = getKey(entry);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }
  return grouped;
}

function formatReport(grouped) {
  const lines = [];
  for (const [groupName, entries] of Object.entries(grouped)) {
    const totalMs = entries.reduce((sum, e) => sum + Number(e.duration), 0);
    lines.push(
      `\n${groupName} — итого: ${formatDuration(totalMs)} | полные(x1.25): ${formatDuration(totalMs * 1.25)}`,
    );
    for (const entry of entries) {
      const start = new Date(Number(entry.start)).toLocaleTimeString("ru-RU");
      const end = entry.end
        ? new Date(Number(entry.end)).toLocaleTimeString("ru-RU")
        : "в процессе";
      const list = entry.task_location?.list_name
        ? ` [${entry.task_location.list_name}]`
        : "";
      const billable = entry.billable ? "billable" : "unbillable";
      lines.push(
        `  [${start} → ${end}] ${formatDuration(entry.duration)} — ${entry.task?.name ?? "без задачи"}${list} (${entry.user?.username ?? "?"}) (${billable})`,
      );
    }
  }
  return lines.join("\n");
}

const SCHEMA_DOC = `ClickUp time entry — структура полей:

Поля записи:
  id                               — ID записи
  task.id / .name / .status.status — задача
  user.id / .username / .email     — кто залогировал время
  billable                         — boolean (платная/бесплатная)
  start / end                      — timestamp в мс (строка), end=null если идёт
  duration                         — длительность в мс (строка)
  description                      — заметка
  tags                             — массив тегов
  is_locked                        — boolean
  task_location.folder_id / .folder_name  — проект (project)
  task_location.list_id / .list_name      — борда (board)
  task_location.space_id / .space_name    — спейс
  task_url                         — ссылка на задачу

Маппинг терминов:
  "проект" (project)  = task_location.folder_name
  "борда" (board)     = task_location.list_name
  "задача" (task)     = task.name
  "платная/бесплатная" = billable (true/false)

Значения group_by для get_time_report:
  "folder"   — по проекту/папке (по умолчанию)
  "list"     — по борде
  "user"     — по пользователю
  "billable" — billable / unbillable
  "task"     — по названию задачи
  "space"    — по спейсу`;

const server = new Server(
  { name: "clickup-timesheet", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_time_entries",
      description:
        "Получить сырые time entries из ClickUp. Возвращает полный JSON-массив записей. Используй для кастомного анализа и фильтрации.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Дата в формате YYYY-MM-DD (по умолчанию: сегодня)",
          },
          start_date: {
            type: "string",
            description: "Начало диапазона YYYY-MM-DD (используй с end_date)",
          },
          end_date: {
            type: "string",
            description: "Конец диапазона YYYY-MM-DD (используй с start_date)",
          },
        },
      },
    },
    {
      name: "get_time_report",
      description:
        "Получить сгруппированный отчёт по time entries. По умолчанию группировка по проекту (folder). Показывает итоговое время, полные (x1.25) и детали по каждой записи. ВАЖНО: возвращённый текст отчёта нужно показывать пользователю ЦЕЛИКОМ и ДОСЛОВНО — со всеми полями каждой записи (интервал начало→конец, длительность, название задачи, борда в [скобках], пользователь, billable/unbillable). НЕ сокращай, НЕ опускай строки и поля, не переформатируй на своё усмотрение.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Дата в формате YYYY-MM-DD (по умолчанию: сегодня)",
          },
          start_date: {
            type: "string",
            description: "Начало диапазона YYYY-MM-DD",
          },
          end_date: {
            type: "string",
            description: "Конец диапазона YYYY-MM-DD",
          },
          group_by: {
            type: "string",
            enum: ["folder", "list", "user", "billable", "task", "space"],
            description:
              "Группировать по: folder=проект (по умолчанию), list=борда, user=пользователь, billable, task=задача, space",
          },
        },
      },
    },
    {
      name: "get_schema",
      description:
        "Получить описание полей time entry и маппинг терминов (проект, борда, задача). Вызывай перед анализом, если нужно понять структуру данных.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "get_schema") {
      return { content: [{ type: "text", text: SCHEMA_DOC }] };
    }

    if (name === "get_time_entries") {
      const entries = await fetchEntries(args.date, args.start_date, args.end_date);
      if (!entries.length) {
        return { content: [{ type: "text", text: "Нет записей за указанный период." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }

    if (name === "get_time_report") {
      const entries = await fetchEntries(args.date, args.start_date, args.end_date);
      if (!entries.length) {
        return { content: [{ type: "text", text: "Нет записей за указанный период." }] };
      }
      const grouped = groupEntries(entries, args.group_by ?? "folder");
      return { content: [{ type: "text", text: formatReport(grouped) }] };
    }

    return {
      content: [{ type: "text", text: `Неизвестный инструмент: ${name}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Ошибка: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
