export type ScrollDirection = 'up' | 'down';

export type AgentAction =
  | { action: 'click'; index: number }
  | { action: 'type'; index: number; text: string; submit: boolean }
  | { action: 'select'; index: number; value: string }
  | { action: 'scroll'; direction: ScrollDirection; amount: number }
  | { action: 'navigate'; url: string }
  | { action: 'go_back' }
  | { action: 'wait'; ms: number }
  | { action: 'new_tab'; url: string }
  | { action: 'switch_tab'; tab_id: number }
  | { action: 'extract'; note: string }
  | { action: 'done'; result: string }
  | { action: 'ask_user'; question: string };

export type ActionName = AgentAction['action'];

/** Решение модели на один шаг: цепочка действий с общим обоснованием. */
export interface AgentStep {
  reasoning: string;
  expected_outcome: string;
  actions: AgentAction[];
}

export const ACTION_NAMES: readonly ActionName[] = [
  'click',
  'type',
  'select',
  'scroll',
  'navigate',
  'go_back',
  'wait',
  'new_tab',
  'switch_tab',
  'extract',
  'done',
  'ask_user',
];

/** Завершают задачу или передают управление человеку — после них ничего не выполняется. */
export const TERMINAL_ACTIONS: ReadonlySet<ActionName> = new Set(['done', 'ask_user']);
/** Меняют страницу/вкладку — номера элементов после них недействительны. */
export const PAGE_CHANGING_ACTIONS: ReadonlySet<ActionName> = new Set(['navigate', 'go_back', 'new_tab', 'switch_tab']);

export const MAX_WAIT_MS = 30_000;

type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' });
const int = (minimum: number): JsonSchema => ({ type: 'integer', minimum });

function actionSchema(name: ActionName, props: Record<string, JsonSchema> = {}, optional: string[] = []): JsonSchema {
  const required = ['action', ...Object.keys(props).filter((k) => !optional.includes(k))];
  return {
    type: 'object',
    properties: { action: { type: 'string', enum: [name] }, ...props },
    required,
    additionalProperties: false,
  };
}

/**
 * JSON Schema ответа для response_format. Только конструкции, которые понимает
 * конвертер схем в грамматику llama.cpp (его же использует Ollama): enum, anyOf, required, maxItems.
 */
export function agentResponseSchema(maxActions: number): JsonSchema {
  return {
    type: 'object',
    properties: {
      reasoning: str(),
      expected_outcome: str(),
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: maxActions,
        items: {
          anyOf: [
            actionSchema('click', { index: int(1) }),
            actionSchema('type', { index: int(1), text: str(), submit: { type: 'boolean' } }, ['submit']),
            actionSchema('select', { index: int(1), value: str() }),
            actionSchema('scroll', { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } }, ['amount']),
            actionSchema('navigate', { url: str() }),
            actionSchema('go_back'),
            actionSchema('wait', { ms: int(0) }),
            actionSchema('new_tab', { url: str() }),
            actionSchema('switch_tab', { tab_id: int(0) }),
            actionSchema('extract', { note: str() }),
            actionSchema('done', { result: str() }),
            actionSchema('ask_user', { question: str() }),
          ],
        },
      },
    },
    required: ['reasoning', 'expected_outcome', 'actions'],
    additionalProperties: false,
  };
}

/** Короткая запись действия для UI и истории: `click [12]`, `type [3] "почта" ⏎`. */
export function formatAction(a: AgentAction): string {
  const q = (s: string, max = 60) => `"${s.length > max ? `${s.slice(0, max - 1)}…` : s}"`;
  switch (a.action) {
    case 'click':
      return `click [${a.index}]`;
    case 'type':
      return `type [${a.index}] ${q(a.text)}${a.submit ? ' ⏎' : ''}`;
    case 'select':
      return `select [${a.index}] ${q(a.value)}`;
    case 'scroll':
      return `scroll ${a.direction} ${a.amount}`;
    case 'navigate':
      return `navigate ${a.url}`;
    case 'go_back':
      return 'go_back';
    case 'wait':
      return `wait ${a.ms}ms`;
    case 'new_tab':
      return `new_tab ${a.url}`;
    case 'switch_tab':
      return `switch_tab ${a.tab_id}`;
    case 'extract':
      return `extract ${q(a.note, 120)}`;
    case 'done':
      return `done ${q(a.result, 120)}`;
    case 'ask_user':
      return `ask_user ${q(a.question, 120)}`;
  }
}
