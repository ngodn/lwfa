import { useMemo } from "react"

import { useSessionActions } from "@/session"

/** Physical and touch controls share press/release and analog output. */
export function useGamepadOutput() {
  const actions = useSessionActions()
  return useMemo(() => ({
    button: (button: number, pressed: boolean) =>
      actions.send({ type: "gamepadButton", button, pressed }),
    axis: (axis: number, value: number) =>
      actions.send({ type: "gamepadAxis", axis, value }),
  }), [actions])
}
