import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Invariant tests for the board card head — the Aug 2026 demotion of the stop
 * code (style-guide.md §Card anatomy). `app.js` needs a DOM so it is never
 * imported here; these are source-level assertions in the manner of the
 * module-contract block in [origin.test.ts](./origin.test.ts). Looks are the
 * style guide's business, but the two contracts below are behaviour:
 * a screen-reader user must still be given the code, and the stop page must
 * not be reskinned by a board-only change.
 *
 * The computed URLs are the same bargain [stop-logic.test.ts](./stop-logic.test.ts)
 * documents: a literal `'../public/app.js'` trips TS6059 under `rootDir: "src"`,
 * while a URL built at runtime is never resolved by tsc.
 */
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

describe('board head demotion', () => {
  // The demotion must never become a deletion for assistive tech: the code
  // left the visible link text, so the link carries it hidden — the idiom the
  // stop page plate already uses — and the visible copy on the meta line is
  // silenced so the card never announces the code twice.
  it('keeps the code in the card link accessible name', () => {
    assert.ok(
      appSource.includes('<span class="visually-hidden"> (${escape(stop.code)})</span>'),
      'the card-name inside the card link must carry the visually-hidden code',
    );
  });

  it('hides the visible meta-line code from assistive tech', () => {
    assert.ok(
      appSource.includes('<span class="meta-code" aria-hidden="true">'),
      'the .card-sub code must be aria-hidden — the link already says it',
    );
  });

  // The stop page plate inherits the base `.meta-code` rule and restates only
  // the size it enlarges. A tidy-up that "simplifies" the base rule because
  // the board no longer uses it at head size would silently reskin /stop/:code.
  it('leaves the pole-size base rule in place for the stop page', () => {
    assert.match(
      cssSource,
      /\.meta-code \{[^}]*font-size: 1\.5rem;[^}]*\}/,
      'the base .meta-code rule must stay at 1.5rem — .sp-plate inherits it',
    );
    assert.ok(cssSource.includes('.sp-plate .meta-code'), 'the stop page override must exist');
  });

  it('styles the demoted code by position, scoped to the meta line', () => {
    assert.match(
      cssSource,
      /\.card-sub \.meta-code \{[^}]*font-size: 0\.78rem;[^}]*\}/,
      'the demoted look must attach to .card-sub .meta-code, never to the base rule',
    );
  });

  // The meta line owns the full plate width only because the pin left the head's
  // flex row: in flow, the button reserves its 2.75rem column for the whole head
  // height and the code wraps onto a third line. The rule must stay #board-scoped —
  // hoisting it to bare .card-head would tear the stop page plate's pin out of the
  // flex row it still lives in beside a three-line title.
  it('keeps the board pin out of the head flow, scoped to the board', () => {
    assert.match(
      cssSource,
      /#board \.card-head \.pin \{[^}]*position: absolute;[^}]*\}/,
      'the corner pin must be #board-scoped absolute — the sp-plate pin stays in flex flow',
    );
    assert.match(
      cssSource,
      /#board \.card-name \{[^}]*padding-right:[^}]*\}/,
      'the name must clear the corner pin, or line one runs under the tap target',
    );
  });
});
