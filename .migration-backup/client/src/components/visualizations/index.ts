import { lazy } from "react";

export const YieldFlowCanvas = lazy(() => import("./YieldFlowCanvas"));
export type { YieldFlowCanvasProps, PortfolioPosition } from "./types";
