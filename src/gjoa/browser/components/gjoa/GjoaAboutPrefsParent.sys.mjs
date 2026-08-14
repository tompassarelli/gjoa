/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Parent half of the about:preferences POINTER actor. gjoa owns its settings at
// about:gjoa and does NOT patch Firefox's preferences UI — the child only injects a
// thin pointer into about:preferences. The child has no tab-opening privilege, so
// when the pointer is clicked it asks the parent to open about:gjoa.
export class GjoaAboutPrefsParent extends JSWindowActorParent {
  receiveMessage(msg) {
    if (msg.name !== "GjoaPrefs:OpenSettings") {
      return;
    }
    try {
      // Prefer the actor's owning chrome window; the most-recent browser window
      // covers actor teardown races.
      const win =
        this.browsingContext?.topChromeWindow ||
        Services.wm.getMostRecentWindow("navigator:browser");
      if (win?.openTrustedLinkIn) {
        win.openTrustedLinkIn("about:gjoa", "tab");
      } else {
        console.error(
          "GjoaAboutPrefs: no chrome window with openTrustedLinkIn; cannot open about:gjoa"
        );
      }
    } catch (e) {
      console.error("GjoaAboutPrefs: failed to open about:gjoa", e);
    }
  }
}
