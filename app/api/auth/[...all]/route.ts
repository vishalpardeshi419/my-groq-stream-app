import { toNextJsHandler } from "better-auth/next-js";
import { assertAuthEnvironment, auth } from "@/lib/auth";

const handlers = toNextJsHandler(auth);

export async function GET(request: Request) {
  assertAuthEnvironment();
  return handlers.GET(request);
}

export async function POST(request: Request) {
  assertAuthEnvironment();
  return handlers.POST(request);
}
