import { useRef } from "react"

/** Restore controlled dialogs without a Radix Trigger to their previous element. */
export function useFocusReturn() {
  const scope = useRef<{
    content: HTMLElement
    previous: HTMLElement | null
    interactedOutside: boolean
  } | null>(null)

  return {
    onOpenAutoFocus(event: Event) {
      if (!(event.target instanceof HTMLElement)) return
      let previous =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      // Queued file requests replace their content in one commit. The old
      // focused node is gone, but its return target still belongs to the queue.
      if (
        previous === document.body && scope.current &&
        !scope.current.content.isConnected && !scope.current.interactedOutside
      ) {
        previous = scope.current.previous
      }
      scope.current = { content: event.target, previous, interactedOutside: false }
      // Keep Radix's initial focus and modal keyboard navigation.
    },
    onInteractOutside(event: Event) {
      if (!event.defaultPrevented && scope.current) scope.current.interactedOutside = true
    },
    onCloseAutoFocus(event: Event) {
      // Radix normally restores its Trigger, which these controlled overlays lack.
      event.preventDefault()
      const closing = scope.current
      // An old content's delayed cleanup must not consume a replacement's target.
      if (!closing || closing.content !== event.target) return
      scope.current = null
      const { previous: target, content, interactedOutside } = closing
      const current = document.activeElement
      if (
        interactedOutside || !target?.isConnected ||
        target === document.body || target === document.documentElement ||
        !document.hasFocus() || document.visibilityState === "hidden"
      ) {
        return
      }
      // Outside clicks and a newly opened overlay own their chosen focus. Body
      // is expected after the closing content has been removed from the DOM.
      if (current && current !== document.body && !content.contains(current)) return
      target.focus({ preventScroll: true })
    },
  }
}
