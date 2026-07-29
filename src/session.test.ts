import { beforeEach, describe, expect, it } from 'vitest';
import { CHALLENGE_COUNT, QuizSession, SessionError } from './session';
import { mountainView } from './data';
import type { QuizData, QuizPoint } from './types';

const MOUNTAIN = {
  id: 'odaigahara-2026-06-11',
  name: '大台ヶ原・日出ヶ岳',
  max_distance_m: 1565.7,
  scoring_k: 4,
};

function point(i: number, withImage = true): QuizPoint {
  const base: QuizPoint = {
    id: `odaigahara-2026-06-11-${String(i).padStart(3, '0')}`,
    mountain_id: MOUNTAIN.id,
    lat: 34.17 + i * 0.001,
    lon: 136.09 + i * 0.001,
    type: 'peak',
    source: 'auto',
  };
  return withImage ? { ...base, image_path: `images/x/${i}.webp`, frame_time_s: i } : base;
}

function makeData(count: number, imagesFor: (i: number) => boolean = () => true): QuizData {
  return {
    dataset_version: '2026-07-29T00:00:00Z',
    mountains: [MOUNTAIN],
    points: Array.from({ length: count }, (_, i) => point(i + 1, imagesFor(i + 1))),
  };
}

/** 再現可能な擬似乱数（テストが揺れないように） */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('QuizSession.challenge（機能H）', () => {
  it('ランダムに重複なく10問出す', () => {
    const session = QuizSession.challenge(makeData(30), 'map2d', seeded(1));
    expect(session.total).toBe(CHALLENGE_COUNT);
    const ids = new Set<string>();
    for (let i = 0; i < session.total; i += 1) ids.add(session.pointAt(i)!.id);
    expect(ids.size).toBe(CHALLENGE_COUNT);
  });

  it('総数が10未満なら全問出す', () => {
    expect(QuizSession.challenge(makeData(4), 'map2d', seeded(2)).total).toBe(4);
  });

  it('乱数が変われば出題も変わる', () => {
    const a = QuizSession.challenge(makeData(50), 'map2d', seeded(1));
    const b = QuizSession.challenge(makeData(50), 'map2d', seeded(999));
    const idsA = Array.from({ length: a.total }, (_, i) => a.pointAt(i)!.id);
    const idsB = Array.from({ length: b.total }, (_, i) => b.pointAt(i)!.id);
    expect(idsA).not.toEqual(idsB);
  });
});

describe('出題対象の絞り込み（3D専用地点）', () => {
  it('モード①は画像を持つ地点だけを出す', () => {
    const data = makeData(10, (i) => i % 2 === 0);
    const session = QuizSession.completeAll(data, 'map2d');
    expect(session.total).toBe(5);
    for (let i = 0; i < session.total; i += 1) {
      expect(session.pointAt(i)!.image_path).toBeTruthy();
    }
  });

  it('モード②は画像が無い地点も出す', () => {
    const data = makeData(10, (i) => i % 2 === 0);
    expect(QuizSession.completeAll(data, 'terrain3d').total).toBe(10);
  });

  it('出題できる地点が無ければ理由つきで失敗する', () => {
    const data = makeData(4, () => false);
    expect(() => QuizSession.completeAll(data, 'map2d')).toThrow(SessionError);
    expect(() => QuizSession.completeAll(data, 'map2d')).toThrow(/3D地形モード/);
  });
});

describe('採点と進行', () => {
  it('ぴったり当てると満点、外すと減る', () => {
    const session = QuizSession.challenge(makeData(3), 'map2d', seeded(3));
    const p = session.current()!;
    const perfect = session.submit({ lat: p.lat, lon: p.lon });
    expect(perfect.points).toBe(5000);
    expect(perfect.distanceM).toBe(0);

    session.advance();
    const q = session.current()!;
    const off = session.submit({ lat: q.lat + 0.005, lon: q.lon });
    expect(off.points).toBeLessThan(5000);
    expect(off.distanceM).toBeGreaterThan(500);
  });

  it('合計点と達成率を出す', () => {
    const session = QuizSession.challenge(makeData(2), 'map2d', seeded(4));
    const a = session.current()!;
    session.submit({ lat: a.lat, lon: a.lon });
    session.advance();
    const b = session.current()!;
    session.submit({ lat: b.lat, lon: b.lon });
    expect(session.totalPoints).toBe(10000);
    expect(session.achievementRate).toBeCloseTo(1, 6);
  });

  it('最後の問題を終えると finished になる', () => {
    const session = QuizSession.challenge(makeData(2), 'map2d', seeded(5));
    session.submit({ lat: 0, lon: 0 });
    expect(session.advance()).toBe(true);
    session.submit({ lat: 0, lon: 0 });
    expect(session.advance()).toBe(false);
    expect(session.finished).toBe(true);
    expect(session.current()).toBeNull();
  });

  it('終わった後に回答しようとすると例外', () => {
    const session = QuizSession.challenge(makeData(1), 'map2d', seeded(6));
    session.submit({ lat: 0, lon: 0 });
    session.advance();
    expect(() => session.submit({ lat: 0, lon: 0 })).toThrow(SessionError);
  });
});

describe('全地点制覇と進捗の保存・再開（機能I）', () => {
  it('全地点を固定の順で出す', () => {
    const data = makeData(7);
    const first = QuizSession.completeAll(data, 'terrain3d');
    const second = QuizSession.completeAll(data, 'terrain3d');
    expect(first.total).toBe(7);
    const ids = (s: QuizSession): string[] =>
      Array.from({ length: s.total }, (_, i) => s.pointAt(i)!.id);
    expect(ids(first)).toEqual(ids(second));
  });

  it('途中経過から同じ地点で再開できる', () => {
    const data = makeData(6);
    const session = QuizSession.completeAll(data, 'terrain3d');
    session.submit({ lat: 0, lon: 0 });
    session.advance();
    session.submit({ lat: 0, lon: 0 });
    session.advance();

    const resumed = QuizSession.resume(data, session.toProgress())!;
    expect(resumed).not.toBeNull();
    expect(resumed.index).toBe(2);
    expect(resumed.total).toBe(6);
    expect(resumed.answered).toHaveLength(2);
    expect(resumed.current()!.id).toBe(session.current()!.id);
    expect(resumed.totalPoints).toBe(session.totalPoints);
  });

  it('進捗には dataset_version が入る', () => {
    const data = makeData(3);
    const progress = QuizSession.completeAll(data, 'map2d').toProgress();
    expect(progress.datasetVersion).toBe(data.dataset_version);
    expect(progress.order).toHaveLength(3);
  });

  it('データが差し替わって地点が消えていたら再開しない', () => {
    const data = makeData(5);
    const progress = QuizSession.completeAll(data, 'map2d').toProgress();
    const shrunk = makeData(2);
    expect(QuizSession.resume(shrunk, progress)).toBeNull();
  });
});

describe('mountainView（初期表示で答えを漏らさない）', () => {
  it('正解地点ではなく山全体の中心を返す', () => {
    const data = makeData(5);
    const view = mountainView(data, MOUNTAIN.id);
    const lats = data.points.map((p) => p.lat);
    expect(view.center.lat).toBeCloseTo((Math.min(...lats) + Math.max(...lats)) / 2, 6);
    // どの地点とも一致しない＝中心が答えにならない
    expect(data.points.some((p) => p.lat === view.center.lat && p.lon === view.center.lon)).toBe(
      false,
    );
  });

  it('地点が1つしかない山では広く引く', () => {
    const data = makeData(1);
    expect(mountainView(data, MOUNTAIN.id).zoom).toBeLessThanOrEqual(10);
  });

  it('未知の山でも落ちない', () => {
    expect(mountainView(makeData(3), 'unknown').zoom).toBeGreaterThan(0);
  });
});

describe('storage（設定・進捗）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('効果音の設定が保存され次回も維持される', async () => {
    const { loadSettings, saveSettings } = await import('./storage');
    expect(loadSettings().soundEnabled).toBe(true);
    saveSettings({ soundEnabled: false });
    expect(loadSettings().soundEnabled).toBe(false);
  });

  it('壊れた値が入っていても既定値に落とす', async () => {
    const { loadSettings, loadProgress } = await import('./storage');
    localStorage.setItem('yamaguessr.settings.v1', '{ broken');
    localStorage.setItem('yamaguessr.progress.v1', 'not json');
    expect(loadSettings().soundEnabled).toBe(true);
    expect(loadProgress()).toBeNull();
  });

  it('進捗を保存・読み出し・削除できる', async () => {
    const { saveProgress, loadProgress, clearProgress } = await import('./storage');
    const data = makeData(3);
    const progress = QuizSession.completeAll(data, 'map2d').toProgress();
    saveProgress(progress);
    expect(loadProgress()?.order).toEqual(progress.order);
    clearProgress();
    expect(loadProgress()).toBeNull();
  });
});
