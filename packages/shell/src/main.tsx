import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { Crashed, watchGlobalErrors } from "@/components/Crashed"
import { ThemeProvider } from "@/components/ThemeProvider"
import "./index.css"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")

// Before the tree exists, so a failure while it is being built is recorded too.
watchGlobalErrors()

createRoot(root).render(
  <StrictMode>
    <ThemeProvider />
    {/*
      * Inside the boundary, and the boundary outside everything else.
      *
      * React unmounts the whole tree when a render or an effect throws with
      * nothing to catch it, which is what turned any single mistake into a
      * blank page. See `Crashed`.
      */}
    <Crashed>
      <App />
    </Crashed>
  </StrictMode>,
)
