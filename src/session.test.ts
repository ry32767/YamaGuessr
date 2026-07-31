import { beforeEach, describe, expect, it } from 'vitest';
import { CHALLENGE_COUNT, QuizSession, SessionError } from './session';
import { TIME_LIMIT_S } from './scoring';
import { mountainView, playableCount } from './data';
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
  return withImage ? { ...base, image_paths: [`images/x/${i}-1.webp`] } : base;
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
    const session = QuizSession.challenge(makeData(30), 'map2d', { random: seeded(1) });
    expect(session.total).toBe(CHALLENGE_COUNT);
    const ids = new Set<string>();
    for (let i = 0; i < session.total; i += 1) ids.add(session.pointAt(i)!.id);
    expect(ids.size).toBe(CHALLENGE_COUNT);
  });

  it('総数が10未満なら全問出す', () => {
    expect(QuizSession.challenge(makeData(4), 'map2d', { random: seeded(2) }).total).toBe(4);
  });

  it('乱数が変われば出題も変わる', () => {
    const a = QuizSession.challenge(makeData(50), 'map2d', { random: seeded(1) });
    const b = QuizSession.challenge(makeData(50), 'map2d', { random: seeded(999) });
    const idsA = Array.from({ length: a.total }, (_, i) => a.pointAt(i)!.id);
    const idsB = Array.from({ length: b.total }, (_, i) => b.pointAt(i)!.id);
    expect(idsA).not.toEqual(idsB);
  });

  it('出題順は出題データの並び（＝GPXルート順）になる', () => {
    const data = makeData(40);
    const order = new Map(data.points.map((p, i) => [p.id, i]));
    for (const seed of [1, 42, 12345]) {
      const session = QuizSession.challenge(data, 'terrain3d', { random: seeded(seed) });
      const indexes = Array.from(
        { length: session.total },
        (_, i) => order.get(session.pointAt(i)!.id)!,
      );
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    }
  });
});

describe('出題対象（どちらのモードも3D地形が手がかり）', () => {
  it('画像が無い地点も地形図当てで出す（一人称3Dを統合したため）', () => {
    const data = makeData(10, (i) => i % 2 === 0);
    expect(QuizSession.completeAll(data, 'map2d').total).toBe(10);
  });

  it('3D地形当ても全地点を出す', () => {
    const data = makeData(10, (i) => i % 2 === 0);
    expect(QuizSession.completeAll(data, 'terrain3d').total).toBe(10);
  });

  it('出題できる地点が無ければ理由つきで失敗する', () => {
    const data = makeData(0);
    expect(() => QuizSession.completeAll(data, 'map2d')).toThrow(SessionError);
    expect(() => QuizSession.completeAll(data, 'map2d')).toThrow(/pipeline/);
  });
});

describe('採点と進行', () => {
  it('ぴったり当てると満点、外すと減る', () => {
    const session = QuizSession.challenge(makeData(3), 'map2d', { random: seeded(3) });
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

  it('時間を使うほど点が減る（歩いた時間も一緒に乗る）', () => {
    const data = makeData(3);
    const instant = QuizSession.challenge(data, 'map2d', { random: seeded(11) });
    const slow = QuizSession.challenge(data, 'map2d', { random: seeded(11) });
    const p = instant.current()!;
    const perfect = instant.submit({ lat: p.lat, lon: p.lon });
    expect(perfect.points).toBe(perfect.basePoints);
    expect(perfect.timeFactor).toBe(1);

    // 同じ精度でも、60秒考えて300m歩いた（登り50m）ぶんだけ倍率が下がる
    const paid = slow.submit(
      { lat: p.lat, lon: p.lon },
      { distanceM: 300, ascentM: 50, descentM: 0 },
      60,
    );
    expect(paid.basePoints).toBe(perfect.basePoints);
    expect(paid.elapsedS).toBe(60);
    expect(paid.walkSecondsS).toBeGreaterThan(0);
    expect(paid.totalTimeS).toBeCloseTo(60 + paid.walkSecondsS, 6);
    expect(paid.timeFactor).toBeLessThan(1);
    expect(paid.points).toBe(Math.round(paid.basePoints * paid.timeFactor));
    expect(paid.points).toBeLessThan(perfect.points);
  });

  it('持ち時間を使い切ると0点', () => {
    const session = QuizSession.challenge(makeData(2), 'map2d', { random: seeded(12) });
    const p = session.current()!;
    const answer = session.submit({ lat: p.lat, lon: p.lon }, undefined, TIME_LIMIT_S + 1);
    expect(answer.basePoints).toBe(5000);
    expect(answer.points).toBe(0);
    expect(session.totalPoints).toBe(0);
  });

  it('合計点と達成率を出す', () => {
    const session = QuizSession.challenge(makeData(2), 'map2d', { random: seeded(4) });
    const a = session.current()!;
    session.submit({ lat: a.lat, lon: a.lon });
    session.advance();
    const b = session.current()!;
    session.submit({ lat: b.lat, lon: b.lon });
    expect(session.totalPoints).toBe(10000);
    expect(session.achievementRate).toBeCloseTo(1, 6);
  });

  it('最後の問題を終えると finished になる', () => {
    const session = QuizSession.challenge(makeData(2), 'map2d', { random: seeded(5) });
    session.submit({ lat: 0, lon: 0 });
    expect(session.advance()).toBe(true);
    session.submit({ lat: 0, lon: 0 });
    expect(session.advance()).toBe(false);
    expect(session.finished).toBe(true);
    expect(session.current()).toBeNull();
  });

  it('終わった後に回答しようとすると例外', () => {
    const session = QuizSession.challenge(makeData(1), 'map2d', { random: seeded(6) });
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

describe('コース（山）の絞り込み', () => {
  function multiMountain(): QuizData {
    const other = { ...MOUNTAIN, id: 'kongo-2026-08-01', name: '金剛山' };
    return {
      dataset_version: '2026-07-29T00:00:00Z',
      mountains: [MOUNTAIN, other],
      points: [
        ...Array.from({ length: 4 }, (_, i) => point(i + 1)),
        ...Array.from({ length: 6 }, (_, i) => ({
          ...point(i + 1),
          id: `kongo-2026-08-01-${i + 1}`,
          mountain_id: other.id,
        })),
      ],
    };
  }

  it('山を指定するとその山の地点だけ出題する', () => {
    const data = multiMountain();
    const session = QuizSession.completeAll(data, 'terrain3d', {
      mountainId: 'kongo-2026-08-01',
    });
    expect(session.total).toBe(6);
    for (let i = 0; i < session.total; i += 1) {
      expect(session.pointAt(i)!.mountain_id).toBe('kongo-2026-08-01');
    }
  });

  it('未指定なら全部の山からまぜて出題する', () => {
    expect(QuizSession.completeAll(multiMountain(), 'terrain3d').total).toBe(10);
  });

  it('10問チャレンジでも絞り込みが効く', () => {
    const session = QuizSession.challenge(multiMountain(), 'terrain3d', {
      mountainId: MOUNTAIN.id,
      random: seeded(7),
    });
    expect(session.total).toBe(4);
  });

  it('playableCount が山ごとに数える', () => {
    const data = multiMountain();
    expect(playableCount(data, null)).toBe(10);
    expect(playableCount(data, MOUNTAIN.id)).toBe(4);
    expect(playableCount(data, 'kongo-2026-08-01')).toBe(6);
    expect(playableCount(data, 'unknown')).toBe(0);
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
