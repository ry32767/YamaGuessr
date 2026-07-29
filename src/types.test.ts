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
    expect(hasImage({ ...base, image_path: 'images/m-001/001.webp' })).toBe(true);
  });

  it('画像が無い地点はモード②（3D）専用', () => {
    expect(hasImage(base)).toBe(false);
  });

  it('空文字は画像なし扱い', () => {
    expect(hasImage({ ...base, image_path: '' })).toBe(false);
  });

  it('モード①の出題対象を絞り込める', () => {
    const points: QuizPoint[] = [
      { ...base, id: 'a', image_path: 'images/a.webp' },
      { ...base, id: 'b' },
      { ...base, id: 'c', image_path: 'images/c.webp' },
    ];
    expect(points.filter(hasImage).map((p) => p.id)).toEqual(['a', 'c']);
  });
});
