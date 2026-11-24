const notes = {
  meeting: "Notes from Tuesday: review the launch checklist and assign follow-up owners.",
};

const refundPolicy =
  "Orders delivered within the last 30 days are eligible for a refund if the item is unopened. Refunds over ₹1,000 require manager sign-off.";

const orders = {
  "123": {
    orderId: "123",
    amount: 5_000,
    currency: "INR",
    daysSincePurchase: 5,
    status: "delivered",
    opened: false,
  },
};

const MAX_EXPRESSION_LENGTH = 256;

class ArithmeticParser {
  private index = 0;
  private readonly tokens: string[] = [];

  constructor(expression: string) {
    if (expression.length > MAX_EXPRESSION_LENGTH) {
      throw new Error("Expression is too long.");
    }

    let cursor = 0;
    while (cursor < expression.length) {
      const match = /^\s*(?:(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/])/.exec(
        expression.slice(cursor),
      );
      if (!match) throw new Error("Expression contains an unsupported character.");

      const token = match[0].trim();
      if (token) this.tokens.push(token);
      cursor += match[0].length;
    }
  }

  parse() {
    if (this.tokens.length === 0) throw new Error("Expression is empty.");

    const result = this.parseExpression();
    if (this.index !== this.tokens.length) {
      throw new Error("Expression contains unexpected input.");
    }
    if (!Number.isFinite(result)) throw new Error("Result is not finite.");
    return result;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const right = this.parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (this.peek() === "*" || this.peek() === "/") {
      const operator = this.take();
      const right = this.parseFactor();
      if (operator === "/" && right === 0) {
        throw new Error("Division by zero is not allowed.");
      }
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }

  private parseFactor(): number {
    if (this.peek() === "+" || this.peek() === "-") {
      const operator = this.take();
      const value = this.parseFactor();
      return operator === "-" ? -value : value;
    }

    if (this.peek() === "(") {
      this.take();
      const value = this.parseExpression();
      if (this.take() !== ")") throw new Error("Missing closing parenthesis.");
      return value;
    }

    const token = this.take();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      throw new Error("Expected a number.");
    }
    return Number(token);
  }

  private peek() {
    return this.tokens[this.index];
  }

  private take() {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error("Expression ended unexpectedly.");
    this.index += 1;
    return token;
  }
}

export function calculate(expression: string) {
  return {
    expression,
    result: new ArithmeticParser(expression).parse(),
  };
}

export function getCurrentTime() {
  return { timestamp: new Date().toISOString() };
}

export function searchNotes(query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const results = Object.entries(notes)
    .filter(([title, content]) => {
      const normalizedContent = content.toLowerCase();
      return (
        title.includes(normalizedQuery) ||
        normalizedContent.includes(normalizedQuery)
      );
    })
    .map(([title, content]) => ({ title, content }));

  return { query, results };
}

export function searchRefundPolicy(query: string) {
  return {
    query,
    policy: refundPolicy,
  };
}

export function getOrderDetails(orderId: string) {
  const order = orders[orderId as keyof typeof orders];
  return order
    ? { ok: true as const, order }
    : { ok: false as const, error: `Order ${orderId} was not found.` };
}

export function simulateRefund(orderId: string, amount: number) {
  const result = getOrderDetails(orderId);
  if (!result.ok) return result;
  if (
    result.order.status !== "delivered" ||
    result.order.opened ||
    result.order.daysSincePurchase > 30
  ) {
    return {
      ok: false as const,
      error: "The order does not meet the refund policy criteria.",
    };
  }
  if (amount !== result.order.amount) {
    return {
      ok: false as const,
      error: `The refund amount must match the order total of ₹${result.order.amount}.`,
    };
  }

  return {
    ok: true as const,
    status: "simulated" as const,
    orderId,
    amount,
    currency: result.order.currency,
    message: "Refund simulated; no payment was issued.",
  };
}
