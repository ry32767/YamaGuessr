import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 実際の音は鳴らせないので、オシレータが何本作られたかで判定する。 */
class MockAudioContext {
  static created = 0;
  static oscillators = 0;
  readonly currentTime = 0;
  readonly destination = {} as AudioDestinationNode;

  constructor() {
    MockAudioContext.created += 1;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  createOscillator(): OscillatorNode {
    MockAudioContext.oscillators += 1;
    const node = {
      type: '',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(() => node),
      start: vi.fn(),
      stop: vi.fn(),
    };
    return node as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    const node = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(() => ({ connect: vi.fn() })),
    };
    return node as unknown as GainNode;
  }
}

async function freshSound(): Promise<typeof import('./sound')> {
  vi.resetModules();
  Object.defineProperty(globalThis, 'window', {
    value: { AudioContext: MockAudioContext },
    configurable: true,
    writable: true,
  });
  return import('./sound');
}

beforeEach(() => {
  localStorage.clear();
  MockAudioContext.created = 0;
  MockAudioContext.oscillators = 0;
});

describe('効果音（機能J）', () => {
  it('既定はオン', async () => {
    const sound = await freshSound();
    expect(sound.isSoundEnabled()).toBe(true);
  });

  it('オンなら音を鳴らす', async () => {
    const sound = await freshSound();
    sound.play('correct');
    expect(MockAudioContext.oscillators).toBeGreaterThan(0);
  });

  it('オフのときはいかなる効果音も鳴らさない', async () => {
    const sound = await freshSound();
    sound.setSoundEnabled(false);
    sound.play('correct');
    sound.play('miss');
    sound.play('finish');
    sound.playForScore(5000);
    expect(MockAudioContext.oscillators).toBe(0);
    expect(MockAudioContext.created).toBe(0);
  });

  it('ON/OFF は localStorage に保存され次回起動でも維持される', async () => {
    const first = await freshSound();
    first.setSoundEnabled(false);
    const second = await freshSound();
    expect(second.isSoundEnabled()).toBe(false);
  });

  it('トグルで反転する', async () => {
    const sound = await freshSound();
    expect(sound.toggleSound()).toBe(false);
    expect(sound.toggleSound()).toBe(true);
  });

  it('4000点以上なら正解音、それ未満は別の音', async () => {
    const sound = await freshSound();
    sound.playForScore(sound.CORRECT_THRESHOLD);
    const correctVoices = MockAudioContext.oscillators;

    MockAudioContext.oscillators = 0;
    sound.playForScore(sound.CORRECT_THRESHOLD - 1);
    const missVoices = MockAudioContext.oscillators;

    // 正解音は3音、それ以外は2音（src/sound.ts の定義）
    expect(correctVoices).toBe(3);
    expect(missVoices).toBe(2);
  });

  it('AudioContext が無い環境でも落ちない', async () => {
    vi.resetModules();
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    const sound = await import('./sound');
    expect(() => sound.play('finish')).not.toThrow();
  });
});
