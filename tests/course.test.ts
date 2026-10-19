import { describe, expect, it } from 'vitest';
import { Course, solveTask, type CourseDeps, type CourseState, type SolveResult } from '@/lib/agent/course';
import type { SkipState } from '@/lib/agent/skipper';

const stuck = (url: string, extra: Partial<SkipState> = {}): SkipState => ({
  status: 'stuck',
  clicks: 5,
  pages: 1,
  last: 'button "Проверить"',
  message: 'Перебрал все кнопки',
  url,
  reason: 'exhausted',
  ...extra,
});

function harness(skips: SkipState[], solves: SolveResult[], withAgent = true) {
  const log: string[] = [];
  const alerts: string[] = [];
  const states: CourseState[] = [];
  const deps: CourseDeps = {
    skip: async () => {
      const s = skips.shift() ?? { status: 'done', clicks: 0, pages: 0, last: '', message: 'конец' };
      log.push(`skip:${s.status}`);
      return s;
    },
    solve: async (task, url) => {
      log.push(`agent:${url}`);
      expect(task).toContain('done');
      return solves.shift() ?? { status: 'done', result: 'НЕ_МОГУ', movedOn: false };
    },
    cancel: () => log.push('cancel'),
    onState: (s) => states.push(s),
    alert: (m) => alerts.push(m),
  };
  return { course: new Course(deps, { withAgent, maxAgentPerPage: 2 }), log, alerts, states };
}

describe('Course — пролистывание с нейросетью на заминках', () => {
  it('застрял → нейросеть → она сдвинула курс → снова пролистывание', async () => {
    const h = harness(
      [stuck('https://p.example/l/1'), stuck('https://p.example/l/3', { pages: 2 })],
      [{ status: 'stopped', movedOn: true }, { status: 'done', result: 'Решил задачу, кнопка «Далее» активна', movedOn: false }],
    );
    const s = await h.course.run();
    expect(h.log).toEqual(['skip:stuck', 'agent:https://p.example/l/1', 'skip:stuck', 'agent:https://p.example/l/3', 'skip:done']);
    expect(s.status).toBe('done');
    expect(s.handoffs).toBe(2);
    expect(s.clicks).toBe(10);
    expect(h.states.some((x) => x.mode === 'agent')).toBe(true);
    expect(h.alerts).toEqual([]);
  });

  it('нейросеть сказала НЕ_МОГУ → стоп и звук', async () => {
    const h = harness([stuck('https://p.example/l/1')], [{ status: 'done', result: 'НЕ_МОГУ: нужна оплата', movedOn: false }]);
    const s = await h.course.run();
    expect(s.status).toBe('stuck');
    expect(s.message).toContain('нужна оплата');
    expect(h.alerts.length).toBe(1);
  });

  it('нейросеть «помогла», а курс снова застрял там же без продвижения — после двух попыток зовёт человека', async () => {
    const page = 'https://p.example/l/1';
    const ok: SolveResult = { status: 'done', result: 'Закрыл окно', movedOn: false };
    const h = harness([stuck(page), stuck(page, { progress: 0 }), stuck(page, { progress: 0 })], [ok, ok, ok]);
    const s = await h.course.run();
    expect(h.log.filter((l) => l.startsWith('agent')).length).toBe(2);
    expect(s.status).toBe('stuck');
    expect(h.alerts.length).toBe(1);
  });

  it('если после нейросети курс продвинулся на той же странице — она снова может помочь', async () => {
    const page = 'https://p.example/l/1';
    const ok: SolveResult = { status: 'done', result: 'Решил', movedOn: false };
    const h = harness([stuck(page), stuck(page, { progress: 3 }), stuck(page, { progress: 2 })], [ok, ok, ok]);
    await h.course.run();
    expect(h.log.filter((l) => l.startsWith('agent')).length).toBe(3);
  });

  it('без нейросети — просто остановка с сигналом, как раньше', async () => {
    const h = harness([stuck('https://p.example/l/1')], [], false);
    const s = await h.course.run();
    expect(h.log).toEqual(['skip:stuck']);
    expect(s.status).toBe('stuck');
    expect(h.alerts.length).toBe(1);
  });

  it('нейросеть остановили вручную — останавливается и пролистывание', async () => {
    const h = harness([stuck('https://p.example/l/1')], [{ status: 'stopped', movedOn: false }]);
    expect((await h.course.run()).status).toBe('stopped');
  });

  it('задача для нейросети объясняет заминку и просит сразу вернуть управление', () => {
    const t = solveTask(stuck('u', { reason: 'loop' }));
    expect(t).toContain('хожу по кругу');
    expect(t).toContain('Проверить');
    expect(t).toContain('НЕ_МОГУ');
  });
});
