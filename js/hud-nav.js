// Gamepad D-pad navigation over the HUD (js/gamepad-controls.js calls it). The D-pad moves a highlight between the
// HUD's buttons by where they sit on screen: the toolbar (map, time of day, teleport, tour, race, buildings, sound,
// clean view), the mode bar and its walker / bike-type switch, and the camera switch. A presses the highlighted button:
// a dropdown opens with the highlight on its chosen item, and the D-pad then moves inside the dropdown only. B closes
// an open dropdown (the highlight goes back to its button), or else hides the highlight. The highlight hides itself
// after IDLE_MS without D-pad input. It is a class (`pad-focus`), not DOM focus, so the keyboard keeps working as before.

const IDLE_MS = 8000;
const HUD_BUTTONS = '.hud button, #race-hud button';
const FIRST = 'btn-open-map'; // where the highlight starts: the toolbar's first button

/** One axis-aligned box: { left, top, right, bottom }. */
const center = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
// The gap between two ranges along one axis (0 when they overlap)
const gap = (a0, a1, b0, b1) => Math.max(0, b0 - a1, a0 - b1);
const OVERLAP = 6;

/**
 * The box from `rects` nearest to `from` in direction `dir` ('up' | 'down' | 'left' | 'right'), or -1. A box counts only
 * when it lies past `from`'s far edge that way (OVERLAP px of overlap allowed), so a button on the same row is never
 * "below"; nearness is the distance along the direction plus twice the sideways gap, so the button straight across beats
 * a closer one off to the side.
 */
function pickNext(from, rects, dir) {
  const c = center(from);
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  let best = -1, bestScore = Infinity;
  rects.forEach((r, i) => {
    if (!r) return;
    const rc = center(r);
    const along = ((horizontal ? rc.x - c.x : rc.y - c.y) * sign);
    const beyond = { right: r.left - from.right, left: from.left - r.right, down: r.top - from.bottom, up: from.top - r.bottom }[dir];
    if (along <= 1 || beyond < -OVERLAP) return;
    const side = horizontal ? gap(from.top, from.bottom, r.top, r.bottom) : gap(from.left, from.right, r.left, r.right);
    const score = along + 2 * side;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

class HudNav {
  constructor({ document: doc = globalThis.document, now = () => performance.now() } = {}) {
    this.doc = doc;
    this.now = now;
    this.current = null;
    this.active = false;
    this.lastInput = -Infinity;
  }

  /** The dropdown open now (a native popover), or null. */
  openPopover() {
    for (const pop of this.doc.querySelectorAll('.popover[popover]')) if (pop.matches(':popover-open')) return pop;
    return null;
  }

  /** Buttons the highlight may land on: inside the open dropdown when there is one, else the HUD's. */
  candidates() {
    const pop = this.openPopover();
    const list = pop ? pop.querySelectorAll('button') : this.doc.querySelectorAll(HUD_BUTTONS);
    return [...list].filter((el) => this.usable(el));
  }

  usable(el) {
    if (!el || el.disabled || el.hidden || el.closest?.('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const style = this.doc.defaultView?.getComputedStyle?.(el);
    // the clean view [H] hides the HUD with opacity and pointer-events: none
    return !style || (style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none');
  }

  setCurrent(el) {
    if (this.current && this.current !== el) this.current.classList.remove('pad-focus');
    this.current = el;
    if (!el) return;
    el.classList.add('pad-focus');
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /** Where the highlight starts: the open dropdown's chosen (or first) item, else the Map button, else the first button. */
  start(list = this.candidates()) {
    const pop = this.openPopover();
    if (pop) return list.find((el) => el.classList.contains('active')) || list[0] || null;
    return list.find((el) => el.id === FIRST) || list[0] || null;
  }

  /** D-pad: show the highlight, or move it one button in `dir`. */
  move(dir) {
    this.lastInput = this.now();
    const list = this.candidates();
    if (!list.length) return this.hide();
    if (!this.active || !list.includes(this.current)) {
      this.active = true;
      this.setCurrent(this.start(list));
      return;
    }
    const i = pickNext(this.current.getBoundingClientRect(), list.map((el) => el.getBoundingClientRect()), dir);
    if (i >= 0) this.setCurrent(list[i]);
  }

  /** A: press the highlighted button. Returns false (the press is the game's) when no highlight shows. */
  press() {
    if (!this.active || !this.current || !this.usable(this.current)) return false;
    this.lastInput = this.now();
    const el = this.current;
    const target = el.getAttribute('popovertarget');
    el.click();
    const pop = this.openPopover();
    if (target && pop?.id === target) {
      this.setCurrent(this.start());
      return true;
    }
    // an item that closed its dropdown hands the highlight back to the dropdown's button (the dropdown may still be
    // animating out, so ask the dropdown, not whether the item still shows)
    if (this.closedOwner(el)) this.returnToInvoker(el);
    return true;
  }

  /** The dropdown `el` sits in when that dropdown is closed, else null. */
  closedOwner(el) {
    const owner = el?.closest?.('.popover[popover]');
    return owner && !owner.matches(':popover-open') ? owner : null;
  }

  returnToInvoker(el) {
    const owner = el.closest('.popover[popover]');
    const invoker = this.doc.querySelector(`[popovertarget="${owner.id}"]`);
    if (invoker && this.usable(invoker)) this.setCurrent(invoker);
    else this.hide();
  }

  /** B: close the open dropdown, else hide the highlight. Returns false when there was nothing to back out of. */
  back() {
    const pop = this.openPopover();
    if (pop && this.active) {
      pop.hidePopover();
      const invoker = this.doc.querySelector(`[popovertarget="${pop.id}"]`);
      this.lastInput = this.now();
      this.setCurrent(invoker && this.usable(invoker) ? invoker : null);
      if (!this.current) this.hide();
      return true;
    }
    if (!this.active) return false;
    this.hide();
    return true;
  }

  hide() {
    this.active = false;
    this.setCurrent(null);
  }

  /** Per frame: hide after IDLE_MS without D-pad input, or when the highlighted button has gone. */
  tick() {
    if (!this.active) return;
    if (this.now() - this.lastInput > IDLE_MS) return this.hide();
    // a dropdown closed some other way (the mouse, Esc): back to its button
    if (this.closedOwner(this.current)) return this.returnToInvoker(this.current);
    if (!this.usable(this.current)) this.hide();
  }
}

export { HudNav, pickNext, IDLE_MS };
