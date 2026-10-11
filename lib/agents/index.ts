import { echoSocial } from "./echosocial";
import { receiptHero } from "./receipthero";
import type { AnyNativeAgent } from "./types";

/** Native agents by slug. Partner agents are called over A2A instead. */
export const NATIVE_AGENTS: Record<string, AnyNativeAgent> = {
  [echoSocial.slug]: echoSocial,
  [receiptHero.slug]: receiptHero,
};

export type { AnyNativeAgent, Grounding, UploadedFile } from "./types";
