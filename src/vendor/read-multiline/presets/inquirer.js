import { styleText } from "node:util";
/** Preset mimicking @inquirer/prompts visual style */
export const inquirer = {
    prefix: { pending: "? ", submitted: "✔ " },
    linePrefix: { pending: "  ", submitted: "  " },
    preferNewlineOnEnter: true,
    helpFooter: {
        items: ["submit", "newline"],
        keyStyle: "bold",
        actionStyle: "dim",
        separator: styleText("dim", " • "),
    },
    theme: {
        prefix: { pending: "blue", submitted: "green" },
        prompt: "bold",
        answer: "cyan",
        submitRender: "preserve",
        cancelRender: "preserve",
    },
};
