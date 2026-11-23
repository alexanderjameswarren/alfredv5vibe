import {
  ANSWER_WAIT_MS, CHECK_MESSAGE, EXTENSION_MARK, STATE_MESSAGE, askDesktop, classify, desktopLine, simulatedState,
} from './desktopCheck';

afterEach(() => {
  jest.useRealTimers();
  document.documentElement.removeAttribute(EXTENSION_MARK);
});

describe('classify', () => {
  test.each([
    [{ panel: true, helper: true }, 'running'],
    [{ panel: true, helper: false }, 'helper_down'],
    [{ panel: false, helper: true }, 'panel_down'],
    [{ panel: false, helper: false }, 'not_running'],
    [{ panel: 'yes', helper: 1 }, 'not_running'],
  ])('%j is %s', (reply, answer) => expect(classify(reply, true).answer).toBe(answer));
  test('no reply: no_answer with the mark, no_extension without', () => {
    expect(classify(null, true).answer).toBe('no_answer');
    expect(classify(null, false).answer).toBe('no_extension');
  });
  test('simulated states match classified ones', () => {
    expect(simulatedState('helper_down')).toEqual({ answer: 'helper_down', panel: true, helper: false });
    expect(simulatedState('running')).toEqual({ answer: 'running', panel: true, helper: true });
  });
});

describe('askDesktop: one message, one 2-second deadline, one reply', () => {
  const fakeWin = () => {
    const listeners = new Set();
    const win = {
      location: { origin: 'http://localhost:3000' },
      posted: [],
      addEventListener: jest.fn((t, f) => listeners.add(f)),
      removeEventListener: jest.fn((t, f) => listeners.delete(f)),
      postMessage: jest.fn((m) => win.posted.push(m)),
      reply: (data, source = win, origin = win.location.origin) => [...listeners].forEach((f) => f({ source, origin, data })),
      listeners,
    };
    return win;
  };

  test('posts one check and resolves with the matching reply; the listener goes', async () => {
    const win = fakeWin();
    const p = askDesktop({ win, id: 'abc' });
    expect(win.posted).toEqual([{ type: CHECK_MESSAGE, id: 'abc' }]);
    win.reply({ type: STATE_MESSAGE, id: 'other', panel: true, helper: true });
    win.reply({ type: STATE_MESSAGE, id: 'abc', panel: true, helper: true }, {});
    win.reply({ type: STATE_MESSAGE, id: 'abc', panel: true, helper: true }, win, 'https://evil.example');
    win.reply({ type: STATE_MESSAGE, id: 'abc', panel: true, helper: false, extension_version: '1.3.0' });
    await expect(p).resolves.toMatchObject({ answer: 'helper_down', extension_version: '1.3.0' });
    expect(win.listeners.size).toBe(0);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
  });

  test('no reply within 2 seconds: no_extension, or no_answer when the mark is on the page; never asks again', async () => {
    jest.useFakeTimers();
    for (const [mark, answer] of [[false, 'no_extension'], [true, 'no_answer']]) {
      if (mark) document.documentElement.setAttribute(EXTENSION_MARK, '1.3.0');
      const win = fakeWin();
      const p = askDesktop({ win, id: 'x' });
      jest.advanceTimersByTime(ANSWER_WAIT_MS - 1);
      let settled = false;
      p.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(p).resolves.toMatchObject({ answer });
      jest.advanceTimersByTime(60 * 1000);
      expect(win.postMessage).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  });

  test('a late reply after the deadline changes nothing', async () => {
    jest.useFakeTimers();
    const win = fakeWin();
    const p = askDesktop({ win, id: 'late' });
    jest.advanceTimersByTime(ANSWER_WAIT_MS);
    win.reply({ type: STATE_MESSAGE, id: 'late', panel: true, helper: true });
    await expect(p).resolves.toMatchObject({ answer: 'no_extension' });
  });
});

describe('desktopLine', () => {
  test.each([
    ['running', 'Desktop ready: Switchboard panel and helper running (checked when this page opened)'],
    ['not_running', "Desktop not ready: the Switchboard panel and the helper aren't running. Start Switchboard on your desktop. (checked when this page opened)"],
    ['panel_down', "Desktop not ready: the Switchboard panel isn't running. Start Switchboard on your desktop. (checked when this page opened)"],
    ['helper_down', "Desktop not ready: the helper isn't running. Start Switchboard on your desktop. (checked when this page opened)"],
    ['no_extension', 'No Alfred extension in this browser. Approve from Chrome on your desktop. (checked when this page opened)'],
    ['no_answer', "The Alfred extension didn't answer. Reload it, then Check again. (checked when this page opened)"],
  ])('%s', (answer, words) => expect(desktopLine(simulatedState(answer), false)).toBe(words));
  test('after a recheck the bracket says "checked just now"; nothing yet says checking', () => {
    expect(desktopLine(simulatedState('running'), true)).toContain('(checked just now)');
    expect(desktopLine(null)).toBe('Checking the desktop…');
  });
});
