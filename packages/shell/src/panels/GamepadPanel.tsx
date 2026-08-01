/**
 * Gamepad panel.
 *
 * Placeholder: the shell, navigation and panel plumbing land first so the
 * layout can be judged on a real device. This panel's feature is next.
 */

import { memo } from "react"
import { NotYet } from "@/panels/parts"

function GamepadPanel() {
  return (
    <div className="space-y-6 pt-2">
      <NotYet what="Gamepad" />
    </div>
  )
}

export default memo(GamepadPanel)
