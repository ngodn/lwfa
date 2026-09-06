/** Bound a test socket's handshake and remove every temporary listener. */
export function waitForOpen(socket, timeoutMs = 5000) {
  if (socket.readyState === 1) return Promise.resolve()
  if (socket.readyState >= 2) return Promise.reject(new Error("dev socket closed before opening"))
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      socket.removeEventListener("open", opened)
      socket.removeEventListener("error", failed)
      socket.removeEventListener("close", closed)
      if (error) reject(error)
      else resolve()
    }
    const opened = () => finish()
    const failed = () => finish(new Error("dev socket unavailable"))
    const closed = () => finish(new Error("dev socket closed before opening"))
    const timer = setTimeout(() => finish(new Error("dev socket handshake timed out")), timeoutMs)
    socket.addEventListener("open", opened)
    socket.addEventListener("error", failed)
    socket.addEventListener("close", closed)
  })
}
