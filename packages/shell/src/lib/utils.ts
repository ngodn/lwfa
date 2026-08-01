import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 *
 * `clsx` handles the conditionals; `twMerge` resolves conflicts, so a caller
 * passing `className="p-6"` actually overrides a component's built-in `p-4`
 * instead of the two fighting over specificity.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
