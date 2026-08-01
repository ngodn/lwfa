/**
 * Apps panel.
 *
 * Placeholder: the shell, navigation and panel plumbing land first so the
 * layout can be judged on a real device. This panel's feature is next.
 */

import { memo } from "react"
import { NotYet } from "@/panels/parts"

function AppsPanel() {
  return (
    <div className="space-y-6 pt-2">
      <NotYet what="Apps" />
    </div>
  )
}

export default memo(AppsPanel)
