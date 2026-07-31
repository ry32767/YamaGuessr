import { describe, expect, it } from 'vitest';
import {
  MAX_SCORE,
  NO_WALK,
  TIME_LIMIT_S,
  distanceMeters,
  formatClock,
  hikingMinutes,
  remainingSeconds,
  scoreForDistance,
  scoreGuess,
  scoreWithTime,
  timeFactor,
  walkSeconds,
} from './scoring';

const MAX = 850;

describe('scoreForDistance（機能E 受け入れ条件）', () => {
  it('距離0で満点5000点', () => {
    expect(scoreForDistance(0, MAX)).toBe(MAX_SCORE);
  });

  it('距離 = max でちょうど0点', () => {
    expect(scoreForDistance(MAX, MAX)).toBe(0);
  });

  it('距離 > max でも0点', () => {
    expect(scoreForDistance(MAX + 1, MAX)).toBe(0);
    expect(scoreForDistance(MAX * 100, MAX)).toBe(0);
  });

  it('距離に対して単調非増加', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= MAX * 1.2; d += 1) {
      const s = scoreForDistance(d, MAX);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  it('max の直前に不連続点がない（max-1m で10点未満）', () => {
    expect(scoreForDistance(MAX - 1, MAX)).toBeLessThan(10);
    // max_distance_m が小さい山でも成立すること
    expect(scoreForDistance(99, 100)).toBeLessThan(10);
  });

  it('スコアは常に 0〜5000 の整数', () => {
    for (let d = 0; d <= MAX; d += 7) {
      const s = scoreForDistance(d, MAX);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(MAX_SCORE);
    }
  });

  it('docs/spec.md の参考カーブ（k=4）と一致する', () => {
    const expected: ReadonlyArray<readonly [number, number]> = [
      [0.05, 4077],
      [0.1, 3321],
      [0.2, 2195],
      [0.3, 1441],
      [0.5, 596],
      [0.75, 160],
      [1.0, 0],
    ];
    for (const [ratio, points] of expected) {
      expect(scoreForDistance(MAX * ratio, MAX, 4)).toBe(points);
    }
  });

  it('k が大きいほど同じ距離での点が辛くなる', () => {
    const d = MAX * 0.2;
    expect(scoreForDistance(d, MAX, 6)).toBeLessThan(scoreForDistance(d, MAX, 4));
    expect(scoreForDistance(d, MAX, 2)).toBeGreaterThan(scoreForDistance(d, MAX, 4));
  });

  it('負の距離は0mとして扱う', () => {
    expect(scoreForDistance(-10, MAX)).toBe(MAX_SCORE);
  });

  it('不正な引数は例外', () => {
    expect(() => scoreForDistance(0, 0)).toThrow(RangeError);
    expect(() => scoreForDistance(0, -1)).toThrow(RangeError);
    expect(() => scoreForDistance(0, MAX, 0)).toThrow(RangeError);
    expect(() => scoreForDistance(Number.NaN, MAX)).toThrow(RangeError);
  });
});

describe('distanceMeters', () => {
  it('同一地点は0m', () => {
    expect(distanceMeters({ lat: 34.4, lon: 135.87 }, { lat: 34.4, lon: 135.87 })).toBe(0);
  });

  it('緯度0.001度（約111m）の差を正しく測る', () => {
    const d = distanceMeters({ lat: 34.4, lon: 135.87 }, { lat: 34.401, lon: 135.87 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(113);
  });

  it('経度差は緯度に応じて縮む（34.4度では約0.82倍）', () => {
    const dLon = distanceMeters({ lat: 34.4, lon: 135.87 }, { lat: 34.4, lon: 135.871 });
    const dLat = distanceMeters({ lat: 34.4, lon: 135.87 }, { lat: 34.401, lon: 135.87 });
    expect(dLon / dLat).toBeCloseTo(Math.cos((34.4 * Math.PI) / 180), 2);
  });

  it('対称である', () => {
    const a = { lat: 34.1851909, lon: 136.1093076 };
    const b = { lat: 34.41, lon: 135.89 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 9);
  });
});

describe('scoreGuess', () => {
  it('ぴったり当てれば満点', () => {
    const p = { lat: 34.1851909, lon: 136.1093076 };
    const r = scoreGuess(p, p, MAX);
    expect(r.distanceM).toBe(0);
    expect(r.score).toBe(MAX_SCORE);
  });

  it('遠く外すと0点', () => {
    const r = scoreGuess(
      { lat: 34.1851909, lon: 136.1093076 },
      { lat: 35.6812, lon: 139.7671 },
      MAX,
    );
    expect(r.score).toBe(0);
    expect(r.distanceM).toBeGreaterThan(300_000);
  });
});

describe('歩いた時間の見積り（機能E-2）', () => {
  it('歩かなければ0', () => {
    expect(hikingMinutes(NO_WALK)).toBe(0);
    expect(walkSeconds(NO_WALK)).toBe(0);
  });

  it('平地は4km/hで見積もる', () => {
    // 1km 平坦 → 15分
    expect(hikingMinutes({ distanceM: 1000, ascentM: 0, descentM: 0 })).toBeCloseTo(15, 3);
    expect(walkSeconds({ distanceM: 1000, ascentM: 0, descentM: 0 })).toBeCloseTo(900, 1);
  });

  it('同じ距離でも登りのほうが高くつく（山の感覚）', () => {
    const flat = hikingMinutes({ distanceM: 200, ascentM: 0, descentM: 0 });
    const up = hikingMinutes({ distanceM: 200, ascentM: 100, descentM: 0 });
    const down = hikingMinutes({ distanceM: 200, ascentM: 0, descentM: 100 });
    expect(up).toBeGreaterThan(down);
    expect(down).toBeGreaterThan(flat);
    // 登り100mで約17分（350m/h）
    expect(up - flat).toBeCloseTo(100 / (350 / 60), 3);
  });

  it('負の値は0として扱う（壊れた入力で時間が戻らない）', () => {
    expect(walkSeconds({ distanceM: -500, ascentM: -100, descentM: -100 })).toBe(0);
  });
});

describe('持ち時間（機能E-2）', () => {
  it('使っていなければ満点、5分で0点', () => {
    expect(timeFactor(0)).toBe(1);
    expect(timeFactor(TIME_LIMIT_S)).toBe(0);
    expect(timeFactor(TIME_LIMIT_S + 100)).toBe(0);
    expect(scoreWithTime(5000, 0)).toBe(5000);
    expect(scoreWithTime(5000, TIME_LIMIT_S)).toBe(0);
  });

  it('直線で減る（バーの見た目と点の減りが一致する）', () => {
    expect(timeFactor(TIME_LIMIT_S / 2)).toBeCloseTo(0.5, 6);
    expect(scoreWithTime(5000, 60)).toBe(4000);   // 1分で 80%
    expect(scoreWithTime(5000, 150)).toBe(2500);  // 2分半で 50%
  });

  it('時間が増えるほど点は減る（単調非増加）', () => {
    let previous = Infinity;
    for (let t = 0; t <= 400; t += 10) {
      const value = scoreWithTime(5000, t);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('残り時間と時計表示', () => {
    expect(remainingSeconds(0)).toBe(TIME_LIMIT_S);
    expect(remainingSeconds(TIME_LIMIT_S + 50)).toBe(0);
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(300)).toBe('5:00');
  });

  it('壊れた入力では0点にする（点が増える方向に倒れない）', () => {
    expect(timeFactor(Number.NaN)).toBe(0);
    expect(timeFactor(-100)).toBe(1);
  });
});
