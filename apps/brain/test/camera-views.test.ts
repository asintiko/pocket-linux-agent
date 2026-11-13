import { describe, expect, it } from 'vitest';
import { CameraViews, MIN_FRAME_GAP_MS, newToken } from '../src/camera-views.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('live camera links', () => {
  it('makes a link nobody could guess and finds it by its token', () => {
    const views = new CameraViews(clock().now);
    const view = views.open({ deviceId: 'd1', userId: 'u1' });
    expect(view.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(newToken()).not.toBe(newToken());
    expect(views.get(view.token)).toMatchObject({ deviceId: 'd1', userId: 'u1' });
    expect(views.get('nope')).toBeUndefined();
  });

  it('dies on its own after a few minutes', () => {
    const c = clock();
    const views = new CameraViews(c.now);
    const view = views.open({ deviceId: 'd1', userId: 'u1', ttlMs: 60_000 });
    c.advance(59_000);
    expect(views.get(view.token)).toBeDefined();
    c.advance(2_000);
    expect(views.get(view.token)).toBeUndefined();
    expect(views.size).toBe(0);
  });

  it('hands out frames no faster than one per gap, so a forgotten tab cannot hold the camera', () => {
    const c = clock();
    const views = new CameraViews(c.now);
    const view = views.open({ deviceId: 'd1', userId: 'u1' });
    expect(views.takeFrame(view)).toBe(true);
    expect(views.takeFrame(view)).toBe(false);
    c.advance(MIN_FRAME_GAP_MS);
    expect(views.takeFrame(view)).toBe(true);
  });

  it('stops every link of one person when they ask, and nobody else\'s', () => {
    const views = new CameraViews(clock().now);
    const mine = views.open({ deviceId: 'd1', userId: 'u1' });
    const theirs = views.open({ deviceId: 'd2', userId: 'u2' });
    expect(views.closeFor('u1')).toBe(1);
    expect(views.get(mine.token)).toBeUndefined();
    expect(views.get(theirs.token)).toBeDefined();
  });
});
