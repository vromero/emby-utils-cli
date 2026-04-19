import { afterAll, afterEach, beforeAll } from "vitest";
import { setupServer } from "msw/node";
import { defaultHandlers } from "./msw-handlers.js";

export { EMBY_HOST, EMBY_API_KEY } from "./constants.js";

export const server = setupServer(...defaultHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers(...defaultHandlers));
afterAll(() => server.close());
