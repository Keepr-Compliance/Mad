/**
 * BACKLOG-3641 (founder) — the page's Keepr box can be moved: dragged with the
 * pointer, or sent corner to corner with its Move button (keyboard); it stays
 * on screen and its place is remembered for the tab's session.
 *
 * Mutations that turn this suite red:
 *   O1 no clamp (the box can leave the screen)        → "stays on screen"
 *   O2 a drag that starts on a button moves the box   → "buttons keep working"
 *   O3 the place not saved at the end of a drag       → "remembers"
 *   O4 a saved place not restored (or not clamped)    → "restores"
 *   O5 the corner cycle stuck / wrong order           → "Move button cycles"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const VIEW = { width: 1000, height: 800 };
const SIZE = { width: 300, height: 100 };

function pointer(type: string, x: number, y: number, target?: Element): void {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  (target ?? box).dispatchEvent(e);
}

let box: HTMLElement;
let saved: Array<{ left: number; top: number }>;

function setup(load: { left: number; top: number } | null = null) {
  document.body.innerHTML = "";
  box = document.createElement("div");
  const button = document.createElement("button");
  button.textContent = "Cancel";
  box.appendChild(button);
  document.body.appendChild(box);
  saved = [];
  const mover = job.attachDrag(box, {
    view: () => VIEW,
    size: () => SIZE,
    load: () => load,
    save: (p: { left: number; top: number }) => saved.push(p),
  });
  return { mover, button };
}

const at = () => ({ left: parseFloat(box.style.left), top: parseFloat(box.style.top) });

describe("the Keepr box can be dragged", () => {
  it("follows the pointer and remembers where it was dropped (O3)", () => {
    setup();
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 450, 350);
    expect(at()).toEqual({ left: 400, top: 300 });
    pointer("pointerup", 450, 350);
    expect(saved).toEqual([{ left: 400, top: 300 }]);
    // Moving without a press does nothing.
    pointer("pointermove", 10, 10);
    expect(at()).toEqual({ left: 400, top: 300 });
  });

  it("stays on screen whatever the pointer does (O1)", () => {
    setup();
    pointer("pointerdown", 0, 0);
    pointer("pointermove", 5000, 5000);
    expect(at()).toEqual({ left: VIEW.width - SIZE.width - 8, top: VIEW.height - SIZE.height - 8 });
    pointer("pointermove", -400, -400);
    expect(at()).toEqual({ left: 8, top: 8 });
  });

  it("buttons keep working: a press on a button does not start a drag (O2)", () => {
    const { button } = setup();
    pointer("pointerdown", 20, 20, button);
    pointer("pointermove", 600, 600);
    pointer("pointerup", 600, 600);
    expect(box.style.left).toBe("");
    expect(saved).toEqual([]);
  });

  it("restores the saved place, clamped to the screen (O4)", () => {
    setup({ left: 5000, top: -20 });
    expect(at()).toEqual({ left: VIEW.width - SIZE.width - 8, top: 8 });
  });
});

describe("the Move button (keyboard alternative)", () => {
  it("cycles the corners clockwise from top-right and remembers each (O5)", () => {
    const { mover } = setup();
    expect(mover.moveToNextCorner()).toBe("bottom-right");
    expect(at()).toEqual({ left: 1000 - 300 - 16, top: 800 - 100 - 16 });
    expect(mover.moveToNextCorner()).toBe("bottom-left");
    expect(at()).toEqual({ left: 16, top: 684 });
    expect(mover.moveToNextCorner()).toBe("top-left");
    expect(at()).toEqual({ left: 16, top: 16 });
    expect(mover.moveToNextCorner()).toBe("top-right");
    expect(at()).toEqual({ left: 684, top: 16 });
    expect(saved).toHaveLength(4);
  });

  it("clampPosition: a box bigger than the view sits at the margin", () => {
    expect(job.clampPosition({ left: 50, top: 50 }, { width: 2000, height: 2000 }, VIEW)).toEqual({ left: 8, top: 8 });
  });
});
