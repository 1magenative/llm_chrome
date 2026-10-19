// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { addHideRule, sitePatternFor, type SiteNote } from '@/lib/agent/site-notes';
import { isHiddenByRules, isUnstableToken, parseHideRules, selectorCandidates, suggestHideRule } from '@/lib/dom/hide-rules';

const $ = (html: string, sel: string) => {
  document.body.innerHTML = html;
  return document.querySelector(sel)!;
};

describe('правила «Скрыть от модели»', () => {
  it('разбор: текст в нижний регистр, css как есть, мусор отбрасывается', () => {
    expect(parseHideRules(['  Оценить ', '', 'css: button[aria-label="Избранное"]', 'CSS:  .Like', 'css: ]]', 'css:'])).toEqual({
      texts: ['оценить'],
      selectors: ['button[aria-label="Избранное"]', '.Like'],
    });
  });

  it('текст ищется в имени, aria-label и title; селектор — через matches', () => {
    const el = $('<button aria-label="Сменить тему" title="Тема" class="t"></button>', 'button');
    const r = (lines: string[]) => isHiddenByRules(el, '', parseHideRules(lines));
    expect(r(['тему'])).toBe(true);
    expect(r(['тема'])).toBe(true);
    expect(r(['css: button.t'])).toBe(true);
    expect(r(['избранное', 'css: a'])).toBe(false);
    expect(isHiddenByRules(el, 'Подарок за друга', parseHideRules(['подарок']))).toBe(true);
  });

  it('сгенерированные классы не годятся для селектора', () => {
    expect(isUnstableToken('css-1x2y3z')).toBe(true);
    expect(isUnstableToken('sc-AbCdE')).toBe(true);
    expect(isUnstableToken('_a1b2c3')).toBe(true);
    expect(isUnstableToken('Button_root__x7f3k2')).toBe(true);
    expect(isUnstableToken('prisma-button2_view_clear')).toBe(false);
    expect(isUnstableToken('like-button')).toBe(false);
  });
});

describe('suggestHideRule — правило по клику', () => {
  it('у кнопки с текстом — сам текст', () => {
    const el = $('<button>Мои курсы</button><button>Все курсы</button>', 'button');
    expect(suggestHideRule(el, 'Мои курсы')).toEqual({ rule: 'Мои курсы', matches: 1 });
  });

  it('у иконки — самый точный стабильный селектор', () => {
    const el = $(
      '<button class="css-9f8e7d icon-button" aria-label="Избранное"><svg></svg></button><button class="icon-button" aria-label="Тема"></button>',
      'button',
    );
    expect(selectorCandidates(el)[0]).toBe('button[aria-label="Избранное"]');
    expect(suggestHideRule(el, '')).toEqual({ rule: 'css: button[aria-label="Избранное"]', matches: 1 });
  });

  it('без атрибутов — по классам, а слишком общий селектор уточняется предком', () => {
    document.body.innerHTML = `
      <div class="lesson-sidebar"><div class="sidebar-icon">☾</div><div class="sidebar-icon">♡</div></div>
      <div class="cards">${'<div class="sidebar-icon"></div>'.repeat(5)}</div>`;
    const el = document.querySelector('.lesson-sidebar .sidebar-icon')!;
    const s = suggestHideRule(el, '');
    expect(s.rule).toBe('css: div.lesson-sidebar div.sidebar-icon');
    expect(s.matches).toBe(2);
  });

  it('одного уникального класса достаточно', () => {
    document.body.innerHTML = `<button class="prisma-button2 prisma-button2_view_clear lesson-theme-switcher"></button>
      <button class="prisma-button2 prisma-button2_view_clear lesson-favorite"></button><button class="prisma-button2 prisma-button2_view_clear"></button>`;
    expect(suggestHideRule(document.querySelector('.lesson-favorite')!, '')).toEqual({ rule: 'css: button.lesson-favorite', matches: 1 });
  });

  it('data-testid важнее всего', () => {
    const el = $('<button data-testid="support-chat" aria-label="Чат" class="x"></button>', 'button');
    expect(suggestHideRule(el, '').rule).toBe('css: [data-testid="support-chat"]');
  });
});

describe('addHideRule — запись в заметку сайта', () => {
  const base: SiteNote[] = [{ pattern: 'practicum.yandex.ru', notes: 'n', hide: 'Оценить', risk: 'ask', safe: '' }];
  it('дописывает в существующую заметку без дублей', () => {
    const once = addHideRule(base, 'Practicum.Yandex.ru', 'Мои курсы');
    expect(once[0]!.hide).toBe('Оценить\nМои курсы');
    expect(addHideRule(once, 'practicum.yandex.ru', 'Мои курсы')[0]!.hide).toBe('Оценить\nМои курсы');
    expect(base[0]!.hide).toBe('Оценить'); // исходный массив не меняется
  });
  it('создаёт заметку для нового сайта', () => {
    expect(addHideRule(base, 'hh.ru', 'css: .chat')[1]).toEqual({ pattern: 'hh.ru', notes: '', hide: 'css: .chat', risk: 'ask', safe: '' });
  });
  it('шаблон из адреса', () => {
    expect(sitePatternFor('https://www.practicum.yandex.ru/learn/x')).toBe('practicum.yandex.ru');
    expect(sitePatternFor('chrome://newtab')).toBe('newtab');
  });
});
