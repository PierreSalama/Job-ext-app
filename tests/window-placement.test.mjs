// BUG-2 regression: the dedicated apply window must not pop up on the user's main display.
// pickApplyWindowBounds places it on a NON-primary display when ≥2 exist, else out of the
// way (bottom-right) on the single display. Pure helper in extension/lib/window-place.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickApplyWindowBounds } from '../extension/lib/window-place.js';

const primary = { id: '1', isPrimary: true, bounds: { left: 0, top: 0, width: 1920, height: 1080 }, workArea: { left: 0, top: 0, width: 1920, height: 1040 } };
const secondary = { id: '2', isPrimary: false, bounds: { left: 1920, top: 0, width: 2560, height: 1440 }, workArea: { left: 1920, top: 0, width: 2560, height: 1400 } };

test('≥2 displays → apply window lands fully on the NON-primary display', () => {
  const b = pickApplyWindowBounds([primary, secondary]);
  assert.ok(b, 'bounds returned');
  // Fully within the secondary display's work area.
  assert.ok(b.left >= secondary.workArea.left, 'left on secondary');
  assert.ok(b.top >= secondary.workArea.top, 'top on secondary');
  assert.ok(b.left + b.width <= secondary.workArea.left + secondary.workArea.width, 'right edge fits secondary');
  assert.ok(b.top + b.height <= secondary.workArea.top + secondary.workArea.height, 'bottom edge fits secondary');
  // It must NOT be on the primary display.
  assert.ok(b.left >= primary.workArea.width, 'window starts past the primary display');
});

test('display order is irrelevant — non-primary is chosen even when listed first', () => {
  const b = pickApplyWindowBounds([secondary, primary]);
  assert.ok(b.left >= secondary.workArea.left, 'still placed on the non-primary display');
});

test('1 display → out of the way (bottom-right), not top-left over the user content', () => {
  const b = pickApplyWindowBounds([primary]);
  assert.ok(b, 'bounds returned');
  // Bottom-right: right edge near the work-area right edge, bottom edge near the bottom.
  assert.ok(b.left + b.width <= primary.workArea.left + primary.workArea.width, 'fits horizontally');
  assert.ok(b.top + b.height <= primary.workArea.top + primary.workArea.height, 'fits vertically');
  // Not top-left (the old left:60, top:60 behavior over the user's content): the window is
  // anchored to the bottom-right corner, so its right/bottom edges hug the work-area edges.
  const rightGap = (primary.workArea.left + primary.workArea.width) - (b.left + b.width);
  const bottomGap = (primary.workArea.top + primary.workArea.height) - (b.top + b.height);
  assert.ok(rightGap >= 0 && rightGap <= 80, 'right edge near the work-area right edge');
  assert.ok(bottomGap >= 0 && bottomGap <= 80, 'bottom edge near the work-area bottom edge');
  assert.ok(b.left > 60 && b.top > 60, 'not pinned to top-left');
});

test('concurrency tiling: 3 worker windows on one display are side-by-side and never overlap', () => {
  const tiles = [0, 1, 2].map((slot) => pickApplyWindowBounds([primary], { slot, slots: 3 }));
  for (const t of tiles) {
    assert.ok(t, 'tile returned');
    assert.ok(t.left >= primary.workArea.left, 'left inside work area');
    assert.ok(t.left + t.width <= primary.workArea.left + primary.workArea.width + 1, 'right edge fits');
    assert.ok(t.top + t.height <= primary.workArea.top + primary.workArea.height + 1, 'bottom edge fits');
  }
  // Strictly left-to-right, non-overlapping columns: each tile starts at/after the previous one's right edge.
  assert.ok(tiles[0].left + tiles[0].width <= tiles[1].left, 'tile 0 does not overlap tile 1');
  assert.ok(tiles[1].left + tiles[1].width <= tiles[2].left, 'tile 1 does not overlap tile 2');
  // And they're genuinely distinct positions.
  assert.notEqual(tiles[0].left, tiles[1].left);
  assert.notEqual(tiles[1].left, tiles[2].left);
});

test('concurrency tiling: tiles land on the NON-primary display when ≥2 exist', () => {
  const t = pickApplyWindowBounds([primary, secondary], { slot: 1, slots: 3 });
  assert.ok(t.left >= secondary.workArea.left, 'tiled on the secondary display');
  assert.ok(t.left + t.width <= secondary.workArea.left + secondary.workArea.width + 1, 'fits secondary');
});

test('slots:1 (single worker) is unchanged — identical to the no-opts call', () => {
  assert.deepEqual(pickApplyWindowBounds([primary], { slot: 0, slots: 1 }), pickApplyWindowBounds([primary]));
});

test('no usable display info → null (caller falls back to legacy placement)', () => {
  assert.equal(pickApplyWindowBounds([]), null);
  assert.equal(pickApplyWindowBounds(null), null);
  assert.equal(pickApplyWindowBounds(undefined), null);
  assert.equal(pickApplyWindowBounds([{ id: 'x' }]), null);  // no bounds/workArea
});

test('window is clamped to fit a small single display', () => {
  const tiny = { id: 't', isPrimary: true, workArea: { left: 0, top: 0, width: 800, height: 600 } };
  const b = pickApplyWindowBounds([tiny]);
  assert.ok(b.width <= 800 && b.height <= 600, 'clamped within the work area');
  assert.ok(b.left >= 0 && b.top >= 0, 'origin inside the work area');
});
