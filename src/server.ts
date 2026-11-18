// Server half of oc-sidebar-extra.
//
// 2.1.3 refuses to load a plugin directory when `server` (and `index`) resolve
// to nothing, so this stub registers an id and does nothing else. tui.tsx holds
// the sidebar blocks.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
	id: "oc-sidebar-extra",
	setup() {},
})
