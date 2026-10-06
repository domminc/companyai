import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { api, type RuntimeInfo } from "./api";

const NONE: RuntimeInfo = { runtime: "node", features: { autostart: false, localHermes: false, files: false } };
const Ctx = createContext<RuntimeInfo>(NONE);

/** What this server can do (it differs between a Mac and Cloudflare); features stay off until it answers. */
export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<RuntimeInfo>(NONE);
  useEffect(() => {
    api.runtime().then(setInfo, () => {});
  }, []);
  return <Ctx.Provider value={info}>{children}</Ctx.Provider>;
}

export const useRuntime = () => useContext(Ctx);
