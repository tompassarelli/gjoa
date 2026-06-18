// Functional test for the niri workspace-binding parser (#41).
//
// reduce-event / switch-to-space are pure (no subprocess, no niri, no chrome
// globals — the Subprocess import is lazy), so they run directly under bun. The
// gjoa chrome modules compile to .beagle-out/ (a different output tree than the
// bun:test harness in .beagle-tools/gjoa/tests/), so this is a standalone check
// rather than a tests/*.test.bjs.
//
//   bun run chrome:compile && bun tools/test-driver/functional/niri-reduce.functional.mjs
//
// Fixtures are the live-captured niri `niri msg event-stream` event shapes.

import { reduce_event, switch_to_space } from "../../../.beagle-out/spaces/niri.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };

// WorkspacesChanged caches by id, no switch.
const r1 = reduce_event(new Map(), { WorkspacesChanged: { workspaces: [
  { id: 1, idx: 2, name: "gjoa", is_focused: true },
  { id: 5, idx: 1, name: "music", is_focused: false }] } });
ok(r1.focused === null, "WorkspacesChanged -> focused null");
ok(r1.cache.get(1).name === "gjoa" && r1.cache.size === 2, "WorkspacesChanged caches by id");

// WorkspaceActivated{focused:true} resolves the name by id from the cache.
ok(reduce_event(r1.cache, { WorkspaceActivated: { id: 5, focused: true } }).focused === "music",
   "WorkspaceActivated{focused:true} -> resolves 'music'");

// per-output WorkspaceActivated{focused:false} is ignored.
ok(reduce_event(r1.cache, { WorkspaceActivated: { id: 1, focused: false } }).focused === null,
   "WorkspaceActivated{focused:false} ignored");

// unnamed workspace (name null) does not drive gjoa.
ok(!reduce_event(new Map([[2, { id: 2, name: null }]]), { WorkspaceActivated: { id: 2, focused: true } }).focused,
   "unnamed workspace -> focused falsy");

// unrelated events ignored.
ok(reduce_event(r1.cache, { Ok: "Handled" }).focused === null, "Ok ack ignored");
ok(reduce_event(r1.cache, { WindowsChanged: { windows: [] } }).focused === null, "WindowsChanged ignored");

// switch_to_space: case-insensitive hit -> setActive only; miss -> create + setActive.
let created = [], activated = [];
const mockSpaces = {
  list: () => [{ id: "w1", name: "Work" }, { id: "m1", name: "Main" }],
  create: (n) => { created.push(n); return { id: "new-" + n, name: n }; },
  setActive: (id) => activated.push(id),
};
switch_to_space(mockSpaces, "work");
ok(created.length === 0 && activated[0] === "w1", "switch hit -> setActive existing (case-insensitive), no create");
switch_to_space(mockSpaces, "Music");
ok(created[0] === "Music" && activated[1] === "new-Music", "switch miss -> create then setActive");

console.log(`\nniri reduce-event/switch-to-space: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
