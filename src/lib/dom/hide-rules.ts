/**
 * «Скрыть от модели»: правила из заметки для сайта, по одному на строку.
 *  - обычный текст — часть имени элемента, aria-label или title (без учёта регистра): «Мои курсы»;
 *  - `css: селектор` — для иконок без текста: `css: button[aria-label="Избранное"]`.
 * Скрытый элемент модель не видит совсем: ни в списке, ни в тексте страницы, ни его содержимое.
 */

export const CSS_PREFIX = 'css:';
/** Строка-переключатель: скрыть иконки без подписи на приклеенных панелях и в тренажёрах (iframe). */
export const ICONS_RULE = '@иконки';
const ICONS_ALIASES = new Set([ICONS_RULE, '@icons']);

export interface HideRules {
  /** Текстовые правила в нижнем регистре. */
  texts: string[];
  /** CSS-селекторы (регистр важен). */
  selectors: string[];
  /** «@иконки»: прятать кнопки-иконки без подписи на приклеенных панелях и во фреймах. */
  icons?: boolean;
}

export function parseHideRules(lines: readonly string[]): HideRules {
  const texts: string[] = [];
  const selectors: string[] = [];
  let icons = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (ICONS_ALIASES.has(line.toLowerCase())) {
      icons = true;
      continue;
    }
    if (line.toLowerCase().startsWith(CSS_PREFIX)) {
      const sel = line.slice(CSS_PREFIX.length).trim();
      if (sel && isValidSelector(sel)) selectors.push(sel);
    } else {
      texts.push(line.toLowerCase());
    }
  }
  return icons ? { texts, selectors, icons } : { texts, selectors };
}

export const hasRules = (r: HideRules): boolean => r.texts.length > 0 || r.selectors.length > 0 || !!r.icons;

function isValidSelector(sel: string): boolean {
  try {
    // DocumentFragment есть и в браузере, и в jsdom; querySelector бросает на синтаксической ошибке.
    globalThis.document?.createDocumentFragment().querySelector(sel);
    return true;
  } catch {
    return false;
  }
}

/** Скрыт ли элемент правилами. name — его доступное имя (как его видит модель). */
export function isHiddenByRules(el: Element, name: string, rules: HideRules): boolean {
  for (const sel of rules.selectors) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      // невалидный селектор отфильтрован при разборе, но страница может быть в другом режиме
    }
  }
  if (rules.texts.length === 0) return false;
  const hay = [name, el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''].join('\n').toLowerCase();
  return rules.texts.some((t) => hay.includes(t));
}

// ——— составление правила по клику ———

const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

/** Похоже на сгенерированное имя (css-1x2y3z, sc-AbCdE, _a1b2c3, хеш): между сборками сайта меняется. */
export function isUnstableToken(token: string): boolean {
  if (/^(css|sc|jsx|emotion|styled|svelte)-/i.test(token)) return true;
  if (/^_/.test(token)) return true;
  // много цифр вперемешку с буквами — хеш
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits >= 3 && /[a-z]/i.test(token)) return true;
  if (/[A-Z].*[a-z].*[A-Z]/.test(token) && !/[-_]/.test(token) && token.length >= 5 && token.length <= 8) return true;
  return false;
}

const cssString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function cssIdent(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`);
}

/** Варианты селектора от самого надёжного к менее надёжному. */
export function selectorCandidates(el: Element): string[] {
  const tag = el.localName;
  const out: string[] = [];
  for (const a of TEST_ATTRS) {
    const v = el.getAttribute(a);
    if (v) out.push(`[${a}=${cssString(v)}]`);
  }
  const aria = el.getAttribute('aria-label');
  if (aria) out.push(`${tag}[aria-label=${cssString(aria)}]`);
  const title = el.getAttribute('title');
  if (title) out.push(`${tag}[title=${cssString(title)}]`);
  const id = el.getAttribute('id');
  if (id && !isUnstableToken(id)) out.push(`#${cssIdent(id)}`);
  const href = el.getAttribute('href');
  if (tag === 'a' && href && href !== '#') out.push(`a[href=${cssString(href)}]`);
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && !isUnstableToken(c));
  // Сначала по одному классу (короткое правило переживёт смену второстепенных классов), потом сочетание.
  const ranked = [...new Set(classes)].sort((a, b) => b.length - a.length).slice(0, 4);
  for (const c of ranked) out.push(`${tag}.${cssIdent(c)}`);
  if (ranked.length > 1) out.push(`${tag}.${ranked.slice(0, 3).map(cssIdent).join('.')}`);
  return out;
}

/** Ближайший предок со стабильным id или классом — чтобы уточнить слишком общий селектор. */
function anchorOf(el: Element): string | null {
  for (let n = el.parentElement; n && n.localName !== 'body'; n = n.parentElement) {
    const id = n.getAttribute('id');
    if (id && !isUnstableToken(id)) return `#${cssIdent(id)}`;
    const cls = (n.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && !isUnstableToken(c));
    if (cls.length) return `${n.localName}.${cssIdent(cls.sort((a, b) => b.length - a.length)[0]!)}`;
  }
  return null;
}

const countIn = (doc: Document, sel: string) => {
  try {
    return doc.querySelectorAll(sel).length;
  } catch {
    return Infinity;
  }
};

export interface HideRuleSuggestion {
  rule: string;
  /** Сколько элементов на странице попадает под правило. */
  matches: number;
}

/**
 * Правило для выбранного элемента: текст, если у элемента есть короткое имя, иначе CSS-селектор,
 * который находит этот элемент и как можно меньше других.
 */
export function suggestHideRule(el: Element, name: string, preferSelector = false): HideRuleSuggestion {
  const doc = el.ownerDocument;
  const clean = name.replace(/\s+/g, ' ').trim();
  // Для кнопки «Далее» текст меняется от урока к уроку («Уф, это всё?», эмодзи) — нужен селектор.
  if (clean && clean.length <= 60 && !preferSelector) {
    const rules = parseHideRules([clean]);
    const all = Array.from(doc.querySelectorAll('a, button, [role], input, select, textarea, summary'));
    const matches = all.filter((e) => isHiddenByRules(e, (e.textContent ?? '').replace(/\s+/g, ' ').trim(), rules)).length;
    return { rule: clean, matches: Math.max(matches, 1) };
  }
  let best: HideRuleSuggestion | null = null;
  for (const sel of selectorCandidates(el)) {
    let s = sel;
    let n = countIn(doc, s);
    if (n > 3) {
      const anchor = anchorOf(el);
      const refined = anchor ? `${anchor} ${sel}` : null;
      if (refined && el.matches(refined)) {
        const rn = countIn(doc, refined);
        if (rn < n) {
          s = refined;
          n = rn;
        }
      }
    }
    if (!el.matches(s)) continue;
    if (!best || n < best.matches) best = { rule: `${CSS_PREFIX} ${s}`, matches: n };
    if (n === 1) break;
  }
  return best ?? { rule: `${CSS_PREFIX} ${el.localName}`, matches: countIn(doc, el.localName) };
}
