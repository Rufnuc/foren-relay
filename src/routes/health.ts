import { Router } from "express";
import type { PinningProvider } from "../services/ipfs";
import type { Dispatcher } from "../services/dispatch";

export function healthRouter(deps: {
  pinning: PinningProvider;
  dispatcher: Dispatcher;
  startedAt: number;
}) {
  const r = Router();

  r.get("/livez", (_req, res) => {
    res.json({ ok: true });
  });

  r.get("/readyz", (_req, res) => {
    res.json({
      ok: true,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      pinning: deps.pinning.name,
      channels: deps.dispatcher.channelsReady(),
    });
  });

  return r;
}
