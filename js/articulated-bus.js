// js/articulated-bus.js
// The Plusbus (a Solaris Urbino 24 electric, double-articulated, 24.7 m) as kinematics: three modules joined by two hitches,
// each trailing module turning about the hitch behind the module in front and following its path (a tractrix), its joint
// clamped to URBINO_24.maxJoint. Pure (no three.js), so it runs in node tests; js/controllers.js drives the front module and
// js/actor-models.js builds the bodies from the same layout. Distances are metres from the nose (docs/aalborg-phase4c.md).

export const URBINO_24 = {
  length: 24.7,
  width: 2.55,
  height: 3.3,
  // modules: nose distance of each end; bellows 0.7 m between them
  modules: [{ from: 0, to: 10.0 }, { from: 10.7, to: 17.7 }, { from: 18.4, to: 24.7 }],
  axles: [2.7, 8.6, 16.55, 22.35], // axle 1 steers; axles 2 and 3 are driven
  hitches: [10.35, 18.05], // the middle of each bellows
  doors: [1.15, 6.6, 14.15, 19.4, 23.65], // centres; double-leaf, 1.2 m wide
  doorWidth: 1.2,
  maxJoint: (38 * Math.PI) / 180,
  wheelbase: 5.9 // axle 1 -> axle 2: the front module's steering geometry
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The articulation state: the front module's reference point (its rear axle, axle 2) and the heading of each module (forward is
 * (sin h, cos h)). `place` lays the bus out straight; `follow` moves the trailers after the front module moved.
 */
export function createArticulation(layout = URBINO_24) {
  const L = layout;
  const s = { x: 0, z: 0, headings: [0, 0, 0], joints: [0, 0] };
  // the reference point of each module: its axle that does not steer (module 0: axle 2; module 1: axle 3; module 2: axle 4)
  const ref = [L.axles[1], L.axles[2], L.axles[3]];
  const refs = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];

  function refsFromHeadings() {
    refs[0].x = s.x; refs[0].z = s.z;
    for (let i = 1; i < 3; i++) {
      const hitch = hitchPoint(i - 1);
      const back = ref[i] - L.hitches[i - 1];
      refs[i].x = hitch.x - Math.sin(s.headings[i]) * back;
      refs[i].z = hitch.z - Math.cos(s.headings[i]) * back;
    }
  }

  /** The hitch behind module i, in the world */
  function hitchPoint(i) {
    const d = L.hitches[i] - ref[i]; // behind the reference axle
    return { x: refs[i].x - Math.sin(s.headings[i]) * d, z: refs[i].z - Math.cos(s.headings[i]) * d };
  }

  return {
    state: s,
    layout: L,
    /** Lay the bus out straight with the front module's centre at (x, z), facing heading */
    place(x, z, heading) {
      const centre = (L.modules[0].from + L.modules[0].to) / 2;
      s.x = x - Math.sin(heading) * (ref[0] - centre);
      s.z = z - Math.cos(heading) * (ref[0] - centre);
      s.headings = [heading, heading, heading];
      s.joints = [0, 0];
      refsFromHeadings();
    },
    /** The front module moved: its reference point is now (x, z), heading h. The trailers follow their hitches. */
    follow(x, z, h) {
      s.x = x; s.z = z; s.headings[0] = h;
      refs[0].x = x; refs[0].z = z;
      for (let i = 1; i < 3; i++) {
        const hitch = hitchPoint(i - 1);
        const back = ref[i] - L.hitches[i - 1];
        // the trailer's axle is dragged towards the hitch: its new heading points from the old axle to the hitch
        let hi = Math.atan2(hitch.x - refs[i].x, hitch.z - refs[i].z);
        if (Math.hypot(hitch.x - refs[i].x, hitch.z - refs[i].z) < 1e-6) hi = s.headings[i];
        let joint = wrap(hi - s.headings[i - 1]);
        if (Math.abs(joint) > L.maxJoint) {
          joint = Math.sign(joint) * L.maxJoint;
          hi = s.headings[i - 1] + joint;
        }
        s.headings[i] = wrap(hi);
        s.joints[i - 1] = joint;
        refs[i].x = hitch.x - Math.sin(hi) * back;
        refs[i].z = hitch.z - Math.cos(hi) * back;
      }
    },
    /** Module i's centre and heading: { x, z, yaw, length } */
    module(i) {
      const m = L.modules[i];
      const d = ref[i] - (m.from + m.to) / 2; // the centre is ahead of the reference axle by this much
      return { x: refs[i].x + Math.sin(s.headings[i]) * d, z: refs[i].z + Math.cos(s.headings[i]) * d, yaw: s.headings[i], length: m.to - m.from };
    },
    /** The ends of bellows j in the world: the rear face of module j and the front face of module j + 1 */
    bellows(j) {
      const a = this.module(j);
      const b = this.module(j + 1);
      const ha = a.length / 2;
      const hb = b.length / 2;
      return {
        a: { x: a.x - Math.sin(a.yaw) * ha, z: a.z - Math.cos(a.yaw) * ha, yaw: a.yaw },
        b: { x: b.x + Math.sin(b.yaw) * hb, z: b.z + Math.cos(b.yaw) * hb, yaw: b.yaw }
      };
    },
    hitch: hitchPoint,
    /** World position of axle k (0..3) */
    axle(k) {
      if (k === 0) return { x: s.x + Math.sin(s.headings[0]) * L.wheelbase, z: s.z + Math.cos(s.headings[0]) * L.wheelbase, yaw: s.headings[0] };
      return { x: refs[k - 1].x, z: refs[k - 1].z, yaw: s.headings[k - 1] };
    },
    /** Copy / restore, for a move that has to be undone (a trailing module ran into a building) */
    save() { return { x: s.x, z: s.z, headings: [...s.headings], joints: [...s.joints], refs: refs.map((r) => ({ ...r })) }; },
    restore(saved) {
      s.x = saved.x; s.z = saved.z; s.headings = [...saved.headings]; s.joints = [...saved.joints];
      saved.refs.forEach((r, i) => { refs[i].x = r.x; refs[i].z = r.z; });
    }
  };
}
