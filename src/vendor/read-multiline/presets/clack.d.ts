import type { SharedConfig } from "../types.js";
/**
 * Preset mimicking @clack/prompts visual style.
 *
 * Pending (active):
 *   │        ← gray guide bar
 *   ◆  msg   ← cyan active symbol
 *   │  input ← cyan bar
 *   └        ← cyan bar end
 *
 * Error (validation failed):
 *   │        ← gray guide bar
 *   ▲  msg   ← yellow warning symbol
 *   │  input ← yellow bar
 *   └        ← yellow bar end + yellow error message
 *
 * Submitted:
 *   │        ← gray guide bar
 *   ◇  msg   ← green submit symbol
 *   │  value ← gray bar + dim answer
 *
 * Cancelled:
 *   │        ← gray guide bar
 *   ■  msg   ← red cancel symbol
 *   │  value ← gray bar + strikethrough dim answer
 */
export declare const clack: SharedConfig;
