import { ChatGroq } from "@langchain/groq";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { z } from "zod";

const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  stepCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
});

const refundPolicy =
  "Orders delivered within the last 30 days are eligible for a refund if the item is unopened. Refunds over INR 1,000 require manager sign-off.";

const orders: Record<string, { amount: number; delivered: boolean; opened: boolean; days: number }> = {
  "123": { amount: 5_000, delivered: true, opened: false, days: 5 },
};

const refundPolicyTool = tool(
  async ({ query }) => ({ query, policy: refundPolicy }),
  {
    name: "search_refund_policy",
    description: "Search the demo refund policy.",
    schema: z.object({ query: z.string().min(1).max(120) }),
  },
);

const orderTool = tool(
  async ({ orderId }) => {
    const order = orders[orderId];
    return order
      ? { ok: true, order: { orderId, ...order } }
      : { ok: false, error: `Order ${orderId} was not found.` };
  },
  {
    name: "get_order_details",
    description: "Fetch details for a demo order.",
    schema: z.object({ orderId: z.string().min(1).max(32) }),
  },
);

const refundTool = tool(
  async ({ orderId, amount }) => {
    const order = orders[orderId];
    if (!order) return { ok: false, error: `Order ${orderId} was not found.` };
    if (!order.delivered || order.opened || order.days > 30) {
      return { ok: false, error: "The order does not meet the refund policy criteria." };
    }
    if (amount !== order.amount) {
      return { ok: false, error: `The refund amount must match the order total of INR ${order.amount}.` };
    }
    return {
      ok: true,
      status: "simulated",
      orderId,
      amount,
      message: "Refund simulated; no payment was issued.",
    };
  },
  {
    name: "refund_order",
    description: "Simulate a refund after human approval.",
    schema: z.object({
      orderId: z.string().min(1).max(32),
      amount: z.number().positive().max(1_000_000),
    }),
  },
);

const calculatorTool = tool(
  async ({ expression }) => {
    if (!/^[0-9+\-*/().\s]+$/.test(expression) || expression.length > 256) {
      return { ok: false, error: "Unsupported expression." };
    }
    try {
      const value = Function(`"use strict"; return (${expression})`)();
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, expression, value }
        : { ok: false, error: "Expression did not produce a finite number." };
    } catch {
      return { ok: false, error: "Invalid arithmetic expression." };
    }
  },
  {
    name: "calculator",
    description: "Evaluate a safe arithmetic expression.",
    schema: z.object({ expression: z.string().min(1).max(256) }),
  },
);

const weatherTool = tool(
  async ({ location }) => ({
    ok: true,
    location,
    temperatureC: 24,
    condition: "demo",
  }),
  {
    name: "get_weather",
    description: "Get weather for a demo location.",
    schema: z.object({ location: z.string().min(1).max(120) }),
  },
);

const tools = [
  refundPolicyTool,
  orderTool,
  refundTool,
  calculatorTool,
  weatherTool,
];

const model = new ChatGroq({
  model: "openai/gpt-oss-120b",
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,
}).bindTools(tools);

const checkpointer = new MemorySaver();

async function callModel(state: typeof AgentState.State) {
  const response = await model.invoke([
    {
      role: "system",
      content:
        "You are a careful assistant. Use tools when needed. For refund decisions, search the policy, inspect the order, then ask for approval before refund_order.",
    },
    ...state.messages,
  ]);
  return { messages: [response], stepCount: state.stepCount + 1 };
}

async function toolNode(state: typeof AgentState.State) {
  const last = state.messages[state.messages.length - 1];
  if (!(last instanceof AIMessage) || !last.tool_calls?.length) {
    return { messages: [] };
  }

  const toolMessages: ToolMessage[] = [];
  for (const call of last.tool_calls) {
    if (call.name === "refund_order") {
      const decision = interrupt(
        { action: "refund_order", toolCallId: call.id ?? "", input: call.args },
        {
          responseSchema: z.object({
            approved: z.boolean(),
            reason: z.string().optional(),
          }),
        },
      ) as { approved: boolean; reason?: string };

      if (!decision.approved) {
        toolMessages.push(
          new ToolMessage({
            tool_call_id: call.id ?? "",
            content: JSON.stringify({
              ok: false,
              status: "declined",
              reason: decision.reason ?? "Human approval was declined.",
            }),
          }),
        );
        continue;
      }
    }

    let output: unknown;
    switch (call.name) {
      case "search_refund_policy":
        output = {
          query: String(call.args.query ?? ""),
          policy: refundPolicy,
        };
        break;
      case "get_order_details":
        {
          const orderId = String(call.args.orderId ?? "");
          const order = orders[orderId];
          output = order
            ? { ok: true, order: { orderId, ...order } }
            : { ok: false, error: `Order ${orderId} was not found.` };
        }
        break;
      case "refund_order":
        {
          const orderId = String(call.args.orderId ?? "");
          const amount = Number(call.args.amount);
          const order = orders[orderId];
          if (!order) {
            output = { ok: false, error: `Order ${orderId} was not found.` };
          } else if (!order.delivered || order.opened || order.days > 30) {
            output = { ok: false, error: "The order does not meet the refund policy criteria." };
          } else if (amount !== order.amount) {
            output = { ok: false, error: `The refund amount must match the order total of INR ${order.amount}.` };
          } else {
            output = {
              ok: true,
              status: "simulated",
              orderId,
              amount,
              message: "Refund simulated; no payment was issued.",
            };
          }
        }
        break;
      case "calculator":
        {
          const expression = String(call.args.expression ?? "");
          if (!/^[0-9+\-*/().\s]+$/.test(expression) || expression.length > 256) {
            output = { ok: false, error: "Unsupported expression." };
          } else {
            try {
              const value = Function(`"use strict"; return (${expression})`)();
              output =
                typeof value === "number" && Number.isFinite(value)
                  ? { ok: true, expression, value }
                  : { ok: false, error: "Expression did not produce a finite number." };
            } catch {
              output = { ok: false, error: "Invalid arithmetic expression." };
            }
          }
        }
        break;
      case "get_weather":
        output = {
          ok: true,
          location: String(call.args.location ?? ""),
          temperatureC: 24,
          condition: "demo",
        };
        break;
      default:
      toolMessages.push(
        new ToolMessage({
          tool_call_id: call.id ?? "",
          content: JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` }),
        }),
      );
      continue;
    }

    toolMessages.push(
      new ToolMessage({
        tool_call_id: call.id ?? "",
        content: typeof output === "string" ? output : JSON.stringify(output),
      }),
    );
  }

  return { messages: toolMessages };
}

function shouldContinue(state: typeof AgentState.State) {
  const last = state.messages[state.messages.length - 1];
  if (last instanceof AIMessage && last.tool_calls?.length) return "tools";
  return state.stepCount >= 5 ? END : END;
}

const graph = new StateGraph(AgentState)
  .addNode("llm", callModel)
  .addNode("tools", toolNode)
  .addEdge(START, "llm")
  .addConditionalEdges("llm", shouldContinue, {
    tools: "tools",
    [END]: END,
  })
  .addEdge("tools", "llm")
  .compile({ checkpointer });

export function langGraphThreadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

export function runLangGraph(threadId: string, message: string) {
  return graph.stream(
    { messages: [new HumanMessage(message)], stepCount: 0 },
    {
      ...langGraphThreadConfig(threadId),
      streamMode: "updates",
    },
  );
}

export function resumeLangGraph(
  threadId: string,
  resume: { approved: boolean; reason?: string },
) {
  return graph.stream(new Command({ resume }), {
    ...langGraphThreadConfig(threadId),
    streamMode: "updates",
  });
}

export async function getLangGraphState(threadId: string) {
  return graph.getState(langGraphThreadConfig(threadId));
}
