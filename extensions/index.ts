import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGreeting } from "../src/domain/greeting.js";

const greetingTool = defineTool({
  name: "greet",
  label: "Greet",
  description: "Create a greeting for a person",
  parameters: Type.Object({
    name: Type.String({ description: "Name of person to greet; blank greets world" }),
  }),
  async execute(_toolCallId, params) {
    const greeting = createGreeting(params.name);
    return {
      content: [{ type: "text", text: greeting }],
      details: { greeting },
    };
  },
});

export default function activate(pi: ExtensionAPI): void {
  pi.registerTool(greetingTool);
}
