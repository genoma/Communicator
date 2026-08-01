import { styleText } from "node:util";
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
export const clack = {
    prefix: {
        pending: `${styleText("gray", "│")}\n${styleText("cyan", "◆")}  `,
        submitted: `${styleText("gray", "│")}\n${styleText("green", "◇")}  `,
        cancelled: `${styleText("gray", "│")}\n${styleText("red", "■")}  `,
        error: `${styleText("gray", "│")}\n${styleText("yellow", "▲")}  `,
    },
    linePrefix: {
        pending: `${styleText("cyan", "│")}  `,
        submitted: `${styleText("gray", "│")}  `,
        cancelled: `${styleText("gray", "│")}  `,
        error: `${styleText("yellow", "│")}  `,
    },
    footer: styleText("cyan", "└"),
    helpFooter: false,
    preferNewlineOnEnter: true,
    theme: {
        answer: "dim",
        cancelAnswer: ["strikethrough", "dim"],
        error: "yellow",
        submitRender: "preserve",
        cancelRender: "preserve",
    },
};
