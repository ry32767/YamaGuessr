import { describe, expect, it } from 'vitest';
import { hasImage, type QuizPoint } from './types';

const base: QuizPoint = {
  id: 'p-001',
  mountain_id: 'm-001',
  lat: 34.18519,
  lon: 136.10931,
  type: 'peak',
  source: 'auto',
};

describe('hasImage', () => {
  it('画像を持つ地点はモード①で出題できる', () => {
    expect(hasImage({ ...base, image_paths: ['images/m-001/001-1.webp'] })).toBe(true);
  });

  it('1地点に複数枚あってもよい', () => {
    expect(hasImage({ ...base, image_paths: ['a.webp', 'b.webp', 'c.webp'] })).toBe(true);
  });

  it('画像が無い地点はモード②（3D）専用', () => {
    expect(hasImage(base)).toBe(false);
  });

  it('空配列は画像なし扱い', () => {
    expect(hasImage({ ...base, image_paths: [] })).toBe(false);
  });

  it('モード①の出題対象を絞り込める', () => {
    const points: QuizPoint[] = [
      { ...base, id: 'a', image_paths: ['images/a-1.webp'] },
      { ...base, id: 'b' },
      { ...base, id: 'c', image_paths: ['images/c-1.webp', 'images/c-2.webp'] },
    ];
    expect(points.filter(hasImage).map((p) => p.id)).toEqual(['a', 'c']);
  });
});
