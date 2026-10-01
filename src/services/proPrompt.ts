// One automatic offer, after the user has completed enough work to understand the product.
// The persisted `proAhaTriggeredBy` marker makes this an install-level decision. Later upgrade
// choices stay at explicit Pro entry points instead of interrupting ordinary generation.
const PRO_AHA_THRESHOLD = 10;

export function shouldShowProAha(count: number): boolean {
  return count === PRO_AHA_THRESHOLD;
}

type ProPromptVariant = 'text' | 'image';
type ProPromptListener = (variant: ProPromptVariant) => void;

const listeners = new Set<ProPromptListener>();

export function subscribeProPrompt(listener: ProPromptListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitProPrompt(variant: ProPromptVariant): void {
  return;
}

// Called by generationService after each completed text response
export function checkProPromptForText(delayMs: number): void {
  return;
}

// Called by imageGenerationService after each completed image generation
export function checkProPromptForImage(delayMs: number): void {
  return;
}
